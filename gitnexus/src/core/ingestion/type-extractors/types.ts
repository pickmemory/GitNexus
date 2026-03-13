import type { SyntaxNode } from '../utils.js';

/** Extracts type bindings from a declaration node into the env map */
export type TypeBindingExtractor = (node: SyntaxNode, env: Map<string, string>) => void;

/** Extracts type bindings from a parameter node into the env map */
export type ParameterExtractor = (node: SyntaxNode, env: Map<string, string>) => void;

/** Per-language type extraction configuration */
export interface LanguageTypeConfig {
  /** Node types that represent typed declarations for this language */
  declarationNodeTypes: ReadonlySet<string>;
  /** Extract a (varName → typeName) binding from a declaration node */
  extractDeclaration: TypeBindingExtractor;
  /** Extract a (varName → typeName) binding from a parameter node */
  extractParameter: ParameterExtractor;
  /** Extract a (varName → typeName) binding from a constructor-call initializer.
   *  Called as fallback when extractDeclaration produces no binding for a declaration node.
   *  Only for languages with syntactic constructor markers (new, composite_literal, ::new). */
  extractInitializer?: TypeBindingExtractor;
}
