import {
  CancellationToken,
  Position,
  Location,
  CompletionItem,
  Hover,
  Definition,
  CodeLens,
  Command,
  ReferenceContext,
  InsertTextFormat
} from "vscode-languageserver";
import Uri from "vscode-uri";

// should eventually be moved into this package, since we're overriding a lot of the existing behavior here
import { getAutocompleteSuggestions } from "@apollographql/graphql-language-service-interface";
import {
  getTokenAtPosition,
  getTypeInfo
} from "@apollographql/graphql-language-service-interface/dist/getAutocompleteSuggestions";

import { GraphQLWorkspace } from "./workspace";
import { DocumentUri } from "./project/base";

import {
  positionFromPositionInContainingDocument,
  rangeForASTNode,
  getASTNodeAndTypeInfoAtPosition
} from "./utilities/source";

import {
  GraphQLNamedType,
  Kind,
  GraphQLField,
  GraphQLNonNull,
  isAbstractType,
  TypeNameMetaFieldDef,
  SchemaMetaFieldDef,
  TypeMetaFieldDef,
  typeFromAST,
  GraphQLType,
  isObjectType,
  isListType,
  GraphQLList,
  isNonNullType,
  ASTNode
} from "graphql";
import { highlightNodeForNode } from "./utilities/graphql";

import { GraphQLClientProject } from "./project/client";
import { isNotNullOrUndefined } from "./utilities/predicates";

function hasFields(type: GraphQLType): boolean {
  return (
    isObjectType(type) ||
    (isListType(type) && hasFields((type as GraphQLList<any>).ofType)) ||
    (isNonNullType(type) && hasFields((type as GraphQLNonNull<any>).ofType))
  );
}

function uriForASTNode(node: ASTNode): DocumentUri | null {
  const uri = node.loc && node.loc.source && node.loc.source.name;
  if (!uri || uri === "GraphQL") {
    return null;
  }
  return uri;
}

function locationForASTNode(node: ASTNode): Location | null {
  const uri = uriForASTNode(node);
  if (!uri) return null;
  return Location.create(uri, rangeForASTNode(node));
}

export class GraphQLLanguageProvider {
  constructor(public workspace: GraphQLWorkspace) {}

  async provideCompletionItems(
    uri: DocumentUri,
    position: Position,
    _token: CancellationToken
  ): Promise<CompletionItem[]> {
    const project = this.workspace.projectForFile(uri);
    if (!(project && project instanceof GraphQLClientProject)) return [];

    const document = project.documentAt(uri, position);
    if (!document) return [];

    if (!project.schema) return [];

    const positionInDocument = positionFromPositionInContainingDocument(
      document.source,
      position
    );
    const token = getTokenAtPosition(document.source.body, positionInDocument);
    const state =
      token.state.kind === "Invalid" ? token.state.prevState : token.state;
    const typeInfo = getTypeInfo(project.schema, token.state);

    if (
      state.kind === "SelectionSet" ||
      state.kind === "Field" ||
      state.kind === "AliasedField"
    ) {
      const parentType = typeInfo.parentType;
      const parentFields = {
        ...(parentType.getFields() as {
          [label: string]: GraphQLField<any, any>;
        })
      };

      if (isAbstractType(parentType)) {
        parentFields[TypeNameMetaFieldDef.name] = TypeNameMetaFieldDef;
      }

      if (parentType === project.schema.getQueryType()) {
        parentFields[SchemaMetaFieldDef.name] = SchemaMetaFieldDef;
        parentFields[TypeMetaFieldDef.name] = TypeMetaFieldDef;
      }

      return getAutocompleteSuggestions(
        project.schema,
        document.source.body,
        positionInDocument
      ).map(suggest => {
        // when code completing fields, expand out required variables and open braces
        const suggestedField = parentFields[suggest.label] as GraphQLField<
          void,
          void
        >;
        if (!suggestedField) {
          return suggest;
        } else {
          const requiredArgs = suggestedField.args.filter(
            a => a.type instanceof GraphQLNonNull
          );
          const paramsSection =
            requiredArgs.length > 0
              ? `(${requiredArgs
                  .map((a, i) => `${a.name}: $${i + 1}`)
                  .join(", ")})`
              : ``;

          const snippet = hasFields(suggestedField.type)
            ? `${suggest.label}${paramsSection} {\n\t$0\n}`
            : `${suggest.label}${paramsSection}`;

          return {
            ...suggest,
            insertText: snippet,
            insertTextFormat: InsertTextFormat.Snippet
          };
        }
      });
    } else {
      return getAutocompleteSuggestions(
        project.schema,
        document.source.body,
        positionInDocument
      );
    }
  }

  async provideHover(
    uri: DocumentUri,
    position: Position,
    _token: CancellationToken
  ): Promise<Hover | null> {
    const project = this.workspace.projectForFile(uri);
    if (!(project && project instanceof GraphQLClientProject)) return null;

    const document = project.documentAt(uri, position);
    if (!(document && document.ast)) return null;

    if (!project.schema) return null;

    const positionInDocument = positionFromPositionInContainingDocument(
      document.source,
      position
    );

    const nodeAndTypeInfo = getASTNodeAndTypeInfoAtPosition(
      document.source,
      positionInDocument,
      document.ast,
      project.schema
    );

    if (nodeAndTypeInfo) {
      const [node, typeInfo] = nodeAndTypeInfo;

      switch (node.kind) {
        case Kind.FRAGMENT_SPREAD: {
          const fragmentName = node.name.value;
          const fragment = project.fragments[fragmentName];
          if (fragment) {
            return {
              contents: {
                language: "graphql",
                value: `fragment ${fragmentName} on ${
                  fragment.typeCondition.name.value
                }`
              }
            };
          }
          break;
        }

        case Kind.FIELD: {
          const parentType = typeInfo.getParentType();
          const fieldDef = typeInfo.getFieldDef();

          if (parentType && fieldDef) {
            const argsString =
              fieldDef.args.length > 0
                ? `(${fieldDef.args
                    .map(a => `${a.name}: ${a.type}`)
                    .join(", ")})`
                : "";
            return {
              contents: `
\`\`\`graphql
${parentType}.${fieldDef.name}${argsString}: ${fieldDef.type}
\`\`\`
${fieldDef.description ? fieldDef.description : ""}
`,
              range: rangeForASTNode(highlightNodeForNode(node))
            };
          }

          break;
        }

        case Kind.NAMED_TYPE: {
          const type = project.schema.getType(
            node.name.value
          ) as GraphQLNamedType | void;
          if (!type) break;

          return {
            contents: `
\`\`\`graphql
${String(type)}
\`\`\`
${type.description ? type.description : ""}
`,
            range: rangeForASTNode(highlightNodeForNode(node))
          };
        }

        case Kind.ARGUMENT: {
          const argumentNode = typeInfo.getArgument()!;
          return {
            contents: `
\`\`\`graphql
${argumentNode.name}: ${argumentNode.type}
\`\`\`
${argumentNode.description ? argumentNode.description : ""}
`,
            range: rangeForASTNode(highlightNodeForNode(node))
          };
        }
      }
    }
    return null;
  }

  async provideDefinition(
    uri: DocumentUri,
    position: Position,
    _token: CancellationToken
  ): Promise<Definition> {
    const project = this.workspace.projectForFile(uri);
    if (!(project && project instanceof GraphQLClientProject)) return null;

    const document = project.documentAt(uri, position);
    if (!(document && document.ast)) return null;

    if (!project.schema) return null;

    const positionInDocument = positionFromPositionInContainingDocument(
      document.source,
      position
    );

    const nodeAndTypeInfo = getASTNodeAndTypeInfoAtPosition(
      document.source,
      positionInDocument,
      document.ast,
      project.schema
    );

    if (nodeAndTypeInfo) {
      const [node, typeInfo] = nodeAndTypeInfo;

      switch (node.kind) {
        case Kind.FRAGMENT_SPREAD:
          const fragmentName = node.name.value;
          const fragment = project.fragments[fragmentName];
          if (fragment && fragment.loc) {
            return locationForASTNode(fragment);
          }
          break;
        case Kind.FIELD: {
          const fieldDef = typeInfo.getFieldDef();

          if (!(fieldDef && fieldDef.astNode && fieldDef.astNode.loc)) break;

          return locationForASTNode(fieldDef.astNode);
        }
        case Kind.NAMED_TYPE: {
          const type = typeFromAST(project.schema, node);

          if (!(type && type.astNode && type.astNode.loc)) break;

          return locationForASTNode(type.astNode);
        }
      }
    }
    return null;
  }

  async provideReferences(
    uri: DocumentUri,
    position: Position,
    _context: ReferenceContext,
    _token: CancellationToken
  ): Promise<Location[] | null> {
    const project = this.workspace.projectForFile(uri);
    if (!(project && project instanceof GraphQLClientProject)) return null;

    const document = project.documentAt(uri, position);
    if (!(document && document.ast)) return null;

    if (!project.schema) return null;

    const positionInDocument = positionFromPositionInContainingDocument(
      document.source,
      position
    );

    const nodeAndTypeInfo = getASTNodeAndTypeInfoAtPosition(
      document.source,
      positionInDocument,
      document.ast,
      project.schema
    );

    if (nodeAndTypeInfo) {
      const [node] = nodeAndTypeInfo;

      switch (node.kind) {
        case Kind.FRAGMENT_DEFINITION: {
          const fragmentName = node.name.value;
          return project
            .fragmentSpreadsForFragment(fragmentName)
            .map(fragmentSpread => locationForASTNode(fragmentSpread))
            .filter(isNotNullOrUndefined);
        }
      }
    }

    return null;
  }

  async provideCodeLenses(
    uri: DocumentUri,
    _token: CancellationToken
  ): Promise<CodeLens[]> {
    const project = this.workspace.projectForFile(uri);
    if (!(project && project instanceof GraphQLClientProject)) return [];

    // Wait for the project to be fully initialized, so we always provide code lenses for open files, even
    // if we receive the request before the project is ready.
    await project.whenReady;

    const documents = project.documentsAt(uri);
    if (!documents) return [];

    let codeLenses: CodeLens[] = [];

    for (const document of documents) {
      if (!document.ast) continue;

      for (const definition of document.ast.definitions) {
        if (definition.kind === Kind.OPERATION_DEFINITION) {
          /*
          if (set.endpoint) {
            const fragmentSpreads: Set<
              graphql.FragmentDefinitionNode
            > = new Set();
            const searchForReferencedFragments = (node: graphql.ASTNode) => {
              visit(node, {
                FragmentSpread(node: FragmentSpreadNode) {
                  const fragDefn = project.fragments[node.name.value];
                  if (!fragDefn) return;

                  if (!fragmentSpreads.has(fragDefn)) {
                    fragmentSpreads.add(fragDefn);
                    searchForReferencedFragments(fragDefn);
                  }
                }
              });
            };

            searchForReferencedFragments(definition);

            codeLenses.push({
              range: rangeForASTNode(definition),
              command: Command.create(
                `Run ${definition.operation}`,
                "apollographql.runQuery",
                graphql.parse(
                  [definition, ...fragmentSpreads]
                    .map(n => graphql.print(n))
                    .join("\n")
                ),
                definition.operation === "subscription"
                  ? set.endpoint.subscriptions
                  : set.endpoint.url,
                set.endpoint.headers,
                graphql.printSchema(set.schema!)
              )
            });
          }
          */
        } else if (definition.kind === Kind.FRAGMENT_DEFINITION) {
          // remove project references for fragment now
          // const fragmentName = definition.name.value;
          // const locations = project
          //   .fragmentSpreadsForFragment(fragmentName)
          //   .map(fragmentSpread => locationForASTNode(fragmentSpread))
          //   .filter(isNotNullOrUndefined);
          // const command = Command.create(
          //   `${locations.length} references`,
          //   "editor.action.showReferences",
          //   uri,
          //   rangeForASTNode(definition).start,
          //   locations
          // );
          // codeLenses.push({
          //   range: rangeForASTNode(definition),
          //   command
          // });
        }
      }
    }
    return codeLenses;
  }
}
