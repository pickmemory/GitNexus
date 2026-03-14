# Ruby Resolution Gaps — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 6 Ruby resolution gaps identified in PR #278 code review (items #2 and #6 deferred — require type resolution infrastructure).

**Architecture:** All fixes stay within the existing resolver pattern. Changes touch tree-sitter queries, call-routing types, parse-worker/call-processor property branches, and the integration test file + fixtures. Both `gitnexus/` and `gitnexus-web/` call-routing files must stay in sync.

**Tech Stack:** TypeScript, tree-sitter, Vitest integration tests

**Deferred (type resolution):**
- #2: `User.new` constructor calls → needs `new` → `initialize` mapping via type-env
- #6: `self.method()` receiver → needs `self` → enclosing class type mapping in `lookupTypeEnv`

---

## File Map

| File | Action | Responsible for |
|------|--------|-----------------|
| `gitnexus/src/core/ingestion/tree-sitter-queries.ts:521` | Modify | Fix singleton_method capture label |
| `gitnexus/src/core/ingestion/tree-sitter-queries.ts:527-529` | Modify | Add over-capture documentation comment |
| `gitnexus/src/core/ingestion/call-routing.ts` | Modify | Add `heritageKind` to `RubyHeritageItem`, pass through `calledName` |
| `gitnexus-web/src/core/ingestion/call-routing.ts` | Modify | Mirror call-routing changes |
| `gitnexus/src/core/ingestion/workers/parse-worker.ts:880-926` | Modify | Heritage: use `item.heritageKind`. Properties: add `findEnclosingClassId` + HAS_METHOD |
| `gitnexus/src/core/ingestion/call-processor.ts:147-179` | Modify | Heritage: use `item.heritageKind`. Properties: add `findEnclosingClassId` + HAS_METHOD |
| `gitnexus/test/fixtures/lang-resolution/ruby-app/lib/user.rb` | Modify | Add `extend`, `prepend`, `def self.class_method` with call inside |
| `gitnexus/test/fixtures/lang-resolution/ruby-app/lib/base_model.rb` | Modify | Add `require 'lib/concerns/serializable'` (bare require fixture) |
| `gitnexus/test/fixtures/lang-resolution/ruby-app/lib/concerns/serializable.rb` | No change | Already exists as mixin target |
| `gitnexus/test/integration/resolvers/ruby.test.ts` | Modify | Add assertions for all 6 fixes |

---

## Chunk 1: Singleton Method Label Fix (#1)

### Task 1: Fix `@definition.function` → `@definition.method` for singleton_method

**Files:**
- Modify: `gitnexus/src/core/ingestion/tree-sitter-queries.ts:521`

The tree-sitter query captures `singleton_method` (Ruby `def self.foo`) as `@definition.function`, but `extractFunctionName` in `utils.ts:432` returns `label: 'Method'` for `singleton_method` nodes. This mismatch means any CALLS edge originating inside a singleton method body gets a sourceId computed with `'Method'`, but the node was stored with `'Function'` — the sourceId points nowhere.

Fix: change the query capture to `@definition.method` so it matches the label used by `extractFunctionName`.

- [ ] **Step 1: Write the failing test**

Add a fixture and test for a singleton method containing a call. In `ruby-app/lib/base_model.rb`, add a `def self.factory` method that calls `run_validations`. Then assert a CALLS edge exists from `factory` to `run_validations` with `sourceLabel: 'Method'`.

In `gitnexus/test/fixtures/lang-resolution/ruby-app/lib/base_model.rb`, append inside the class:

```ruby
  def self.factory
    run_validations
  end
```

In `gitnexus/test/integration/resolvers/ruby.test.ts`, add inside the first `describe` block:

```typescript
  it('detects singleton method (def self.factory) as Method', () => {
    const methods = getNodesByLabel(result, 'Method');
    expect(methods).toContain('factory');
  });

  it('emits CALLS from singleton method: factory → run_validations', () => {
    const calls = getRelationships(result, 'CALLS')
      .filter(e => e.source === 'factory' && e.target === 'run_validations');
    expect(calls.length).toBe(1);
    expect(calls[0].sourceLabel).toBe('Method');
  });
```

- [ ] **Step 2: Run the test — expect FAIL**

```bash
cd gitnexus && npx vitest run test/integration/resolvers/ruby.test.ts --reporter=verbose 2>&1 | tail -30
```

Expected: `factory` detected as `Function` (wrong label), and/or CALLS edge missing because sourceId mismatch.

- [ ] **Step 3: Fix the query**

In `gitnexus/src/core/ingestion/tree-sitter-queries.ts`, line 521, change:

```
(singleton_method
  name: (identifier) @name) @definition.function
```

to:

```
(singleton_method
  name: (identifier) @name) @definition.method
```

- [ ] **Step 4: Run the test — expect PASS**

```bash
cd gitnexus && npx vitest run test/integration/resolvers/ruby.test.ts --reporter=verbose 2>&1 | tail -30
```

- [ ] **Step 5: Commit**

```bash
git add gitnexus/src/core/ingestion/tree-sitter-queries.ts \
       gitnexus/test/fixtures/lang-resolution/ruby-app/lib/base_model.rb \
       gitnexus/test/integration/resolvers/ruby.test.ts
git commit -m "fix(ruby): singleton_method query capture uses @definition.method to match extractFunctionName label"
```

---

## Chunk 2: attr_* Properties Missing ownerId / HAS_METHOD (#3)

### Task 2: Add `findEnclosingClassId` + HAS_METHOD to property branches

**Files:**
- Modify: `gitnexus/src/core/ingestion/workers/parse-worker.ts:892-924`
- Modify: `gitnexus/src/core/ingestion/call-processor.ts:158-179`

Both parse-worker and call-processor create Property nodes for `attr_accessor`/`attr_reader`/`attr_writer` but skip the `findEnclosingClassId` walk and don't emit HAS_METHOD edges. The regular definition path (line ~1044-1079 in parse-worker) already does this for Method/Constructor/Property/Function nodes, but the `properties` routing branch bypasses it entirely.

Fix: In both `properties` branches, call `findEnclosingClassId(callNode, file.path)` on the call node (the `attr_*` call is always inside a class body), add `ownerId` to the symbol push, and emit a HAS_METHOD relationship.

- [ ] **Step 1: Write the failing test**

In `gitnexus/test/integration/resolvers/ruby.test.ts`, add inside the first `describe` block:

```typescript
  it('emits HAS_METHOD from User to attr_reader :name', () => {
    const hasMethod = getRelationships(result, 'HAS_METHOD');
    const edge = hasMethod.find(e => e.source === 'User' && e.target === 'name');
    expect(edge).toBeDefined();
  });

  it('emits HAS_METHOD from BaseModel to attr_accessor :id', () => {
    const hasMethod = getRelationships(result, 'HAS_METHOD');
    const edge = hasMethod.find(e => e.source === 'BaseModel' && e.target === 'id');
    expect(edge).toBeDefined();
  });
```

- [ ] **Step 2: Run the test — expect FAIL**

```bash
cd gitnexus && npx vitest run test/integration/resolvers/ruby.test.ts --reporter=verbose 2>&1 | tail -30
```

Expected: HAS_METHOD edges from User/BaseModel to properties don't exist.

- [ ] **Step 3: Fix parse-worker properties branch**

In `gitnexus/src/core/ingestion/workers/parse-worker.ts`, inside the `routed.kind === 'properties'` block (~line 892), after creating the Property node and DEFINES relationship, add `findEnclosingClassId` + ownerId + HAS_METHOD. The `callNode` for the property routing is `captureMap['call']`.

Replace the properties block (lines 892-925) with:

```typescript
            if (routed.kind === 'properties') {
              const propEnclosingClassId = findEnclosingClassId(captureMap['call'], file.path);
              for (const item of routed.items) {
                const nodeId = generateId('Property', `${file.path}:${item.propName}`);
                result.nodes.push({
                  id: nodeId,
                  label: 'Property',
                  properties: {
                    name: item.propName,
                    filePath: file.path,
                    startLine: item.startLine,
                    endLine: item.endLine,
                    language,
                    isExported: true,
                    description: item.accessorType,
                  },
                });
                result.symbols.push({
                  filePath: file.path,
                  name: item.propName,
                  nodeId,
                  type: 'Property',
                  ...(propEnclosingClassId ? { ownerId: propEnclosingClassId } : {}),
                });
                const fileId = generateId('File', file.path);
                const relId = generateId('DEFINES', `${fileId}->${nodeId}`);
                result.relationships.push({
                  id: relId,
                  sourceId: fileId,
                  targetId: nodeId,
                  type: 'DEFINES',
                  confidence: 1.0,
                  reason: '',
                });
                if (propEnclosingClassId) {
                  result.relationships.push({
                    id: generateId('HAS_METHOD', `${propEnclosingClassId}->${nodeId}`),
                    sourceId: propEnclosingClassId,
                    targetId: nodeId,
                    type: 'HAS_METHOD',
                    confidence: 1.0,
                    reason: '',
                  });
                }
              }
              continue;
            }
```

- [ ] **Step 4: Fix call-processor properties branch**

In `gitnexus/src/core/ingestion/call-processor.ts`, inside the `case 'properties'` block (~line 158), add the same pattern. The call node is `captureMap['call']`.

Replace the properties case (lines 158-180) with:

```typescript
          case 'properties': {
            const fileId = generateId('File', file.path);
            const propEnclosingClassId = findEnclosingClassId(captureMap['call'], file.path);
            for (const item of routed.items) {
              const nodeId = generateId('Property', `${file.path}:${item.propName}`);
              graph.addNode({
                id: nodeId,
                label: 'Property' as any,
                properties: {
                  name: item.propName, filePath: file.path,
                  startLine: item.startLine, endLine: item.endLine,
                  language, isExported: true,
                  description: item.accessorType,
                },
              });
              symbolTable.add(file.path, item.propName, nodeId, 'Property',
                undefined, propEnclosingClassId ?? undefined);
              const relId = generateId('DEFINES', `${fileId}->${nodeId}`);
              graph.addRelationship({
                id: relId, sourceId: fileId, targetId: nodeId,
                type: 'DEFINES', confidence: 1.0, reason: '',
              });
              if (propEnclosingClassId) {
                graph.addRelationship({
                  id: generateId('HAS_METHOD', `${propEnclosingClassId}->${nodeId}`),
                  sourceId: propEnclosingClassId, targetId: nodeId,
                  type: 'HAS_METHOD', confidence: 1.0, reason: '',
                });
              }
            }
            return;
          }
```

Note: check `symbolTable.add` signature — it may accept ownerId as a parameter. If so, pass it. If not, the `ownerId` on the symbol push object handles it.

- [ ] **Step 5: Run the test — expect PASS**

```bash
cd gitnexus && npx vitest run test/integration/resolvers/ruby.test.ts --reporter=verbose 2>&1 | tail -30
```

- [ ] **Step 6: Commit**

```bash
git add gitnexus/src/core/ingestion/workers/parse-worker.ts \
       gitnexus/src/core/ingestion/call-processor.ts \
       gitnexus/test/integration/resolvers/ruby.test.ts
git commit -m "fix(ruby): attr_* Property nodes get ownerId and HAS_METHOD edges to enclosing class"
```

---

## Chunk 3: Bare Call Over-Capture Documentation (#4)

### Task 3: Document the bare call over-capture limitation

**Files:**
- Modify: `gitnexus/src/core/ingestion/tree-sitter-queries.ts:527-529`

The `body_statement (identifier)` query captures **any** identifier at statement level as a call, including variable reads. This is a known Ruby ambiguity (bare identifiers can be method calls). The noise is mitigated by `isBuiltInOrNoise` and symbol resolution filtering, but document it.

- [ ] **Step 1: Add documentation comment**

In `gitnexus/src/core/ingestion/tree-sitter-queries.ts`, replace the comment above the bare call query (line 527):

```
; ── Bare calls without parens (identifiers at statement level are method calls) ─
; NOTE: This may over-capture variable reads as calls (e.g. `result` at
; statement level). Ruby's grammar makes bare identifiers ambiguous — they
; could be local variables or zero-arity method calls. Post-processing via
; isBuiltInOrNoise and symbol resolution filtering suppresses most false
; positives, but a variable name that coincidentally matches a method name
; elsewhere may produce a false CALLS edge.
```

- [ ] **Step 2: Commit**

```bash
git add gitnexus/src/core/ingestion/tree-sitter-queries.ts
git commit -m "docs(ruby): document bare call query over-capture limitation in tree-sitter-queries"
```

---

## Chunk 4: extend vs include Heritage Distinction (#5)

### Task 4: Add `heritageKind` to `RubyHeritageItem` and propagate through heritage processing

**Files:**
- Modify: `gitnexus/src/core/ingestion/call-routing.ts`
- Modify: `gitnexus-web/src/core/ingestion/call-routing.ts`
- Modify: `gitnexus/src/core/ingestion/workers/parse-worker.ts:880-888`
- Modify: `gitnexus/src/core/ingestion/call-processor.ts:147-155`

Currently `include`, `extend`, and `prepend` all produce `kind: 'trait-impl'` heritage edges. The semantic distinction matters: `include` adds instance methods, `extend` adds class methods, `prepend` inserts before in MRO.

Fix: Add a `heritageKind` field (`'include' | 'extend' | 'prepend'`) to `RubyHeritageItem`. Pass it through to `ExtractedHeritage.kind` so the heritage processor can distinguish them. For now, all three still produce `IMPLEMENTS` edges (same graph relationship), but the `reason` field on the relationship will carry the distinction (`'include'`, `'extend'`, `'prepend'`) instead of generic `'trait-impl'`.

- [ ] **Step 1: Write the failing test**

In `gitnexus/test/fixtures/lang-resolution/ruby-app/lib/user.rb`, add `extend` and `prepend` lines. Update the file to:

```ruby
require_relative './base_model'
require_relative './concerns/serializable'

class User < BaseModel
  include Serializable
  extend Serializable
  prepend Serializable

  attr_reader :name
  attr_writer :email

  def greet_user
    persist
    serialize_data
  end
end
```

In `gitnexus/test/integration/resolvers/ruby.test.ts`, add:

```typescript
  it('emits IMPLEMENTS edges with distinct reasons for include, extend, prepend', () => {
    const implements_ = getRelationships(result, 'IMPLEMENTS');
    const userToSerializable = implements_.filter(
      e => e.source === 'User' && e.target === 'Serializable'
    );
    expect(userToSerializable.length).toBe(3);
    const reasons = userToSerializable.map(e => e.rel.reason).sort();
    expect(reasons).toEqual(['extend', 'include', 'prepend']);
  });
```

- [ ] **Step 2: Run the test — expect FAIL**

```bash
cd gitnexus && npx vitest run test/integration/resolvers/ruby.test.ts --reporter=verbose 2>&1 | tail -30
```

Expected: all three edges have `reason: 'trait-impl'` (no distinction).

- [ ] **Step 3: Add `heritageKind` to `RubyHeritageItem`**

In `gitnexus/src/core/ingestion/call-routing.ts`, update the interface:

```typescript
export interface RubyHeritageItem {
  enclosingClass: string;
  mixinName: string;
  heritageKind: 'include' | 'extend' | 'prepend';
}
```

In `routeRubyCall`, update the `items.push` call to include `heritageKind`:

```typescript
        items.push({ enclosingClass, mixinName: arg.text, heritageKind: calledName as 'include' | 'extend' | 'prepend' });
```

- [ ] **Step 4: Mirror in `gitnexus-web/src/core/ingestion/call-routing.ts`**

Same changes: add `heritageKind` to `RubyHeritageItem` interface and the `items.push` call.

- [ ] **Step 5: Update parse-worker heritage consumption**

In `gitnexus/src/core/ingestion/workers/parse-worker.ts` (~line 880-888), change:

```typescript
                kind: 'trait-impl',
```

to:

```typescript
                kind: item.heritageKind,
```

- [ ] **Step 6: Update call-processor heritage consumption**

In `gitnexus/src/core/ingestion/call-processor.ts` (~line 153), change:

```typescript
                kind: 'trait-impl',
```

to:

```typescript
                kind: item.heritageKind,
```

- [ ] **Step 7: Update heritage-processor to handle include/extend/prepend kinds**

In `gitnexus/src/core/ingestion/heritage-processor.ts`, the `trait-impl` branch (~line 301) handles these. We need to also match `include`, `extend`, `prepend` kinds, or change the condition.

Check what the `kind` field is used for. Currently line 301:
```typescript
} else if (h.kind === 'trait-impl') {
```

Change to:
```typescript
} else if (h.kind === 'trait-impl' || h.kind === 'include' || h.kind === 'extend' || h.kind === 'prepend') {
```

And update the `reason` field in the relationship (line 316):
```typescript
          reason: h.kind,
```

This is already `'trait-impl'` — now it will be `'include'`, `'extend'`, or `'prepend'`, which is more precise.

- [ ] **Step 8: Run the test — expect PASS**

```bash
cd gitnexus && npx vitest run test/integration/resolvers/ruby.test.ts --reporter=verbose 2>&1 | tail -30
```

- [ ] **Step 9: Commit**

```bash
git add gitnexus/src/core/ingestion/call-routing.ts \
       gitnexus-web/src/core/ingestion/call-routing.ts \
       gitnexus/src/core/ingestion/workers/parse-worker.ts \
       gitnexus/src/core/ingestion/call-processor.ts \
       gitnexus/src/core/ingestion/heritage-processor.ts \
       gitnexus/test/fixtures/lang-resolution/ruby-app/lib/user.rb \
       gitnexus/test/integration/resolvers/ruby.test.ts
git commit -m "feat(ruby): distinguish include/extend/prepend heritage with separate reason values"
```

---

## Chunk 5: Test Coverage Gaps (#7 bare require, #8 prepend)

### Task 5: Add bare `require` test coverage

**Files:**
- Modify: `gitnexus/test/fixtures/lang-resolution/ruby-app/lib/base_model.rb`
- Modify: `gitnexus/test/integration/resolvers/ruby.test.ts`

`resolveRubyImport` handles both `require 'lib/utils'` and `require_relative './utils'`, but only `require_relative` is tested. Add a bare `require` to the fixture.

- [ ] **Step 1: Add bare require to fixture**

In `gitnexus/test/fixtures/lang-resolution/ruby-app/lib/base_model.rb`, add at the top:

```ruby
require 'lib/concerns/serializable'
```

This tests suffix-based resolution of a non-relative require path. The file `concerns/serializable.rb` already exists in the fixture.

- [ ] **Step 2: Write the failing test**

In `gitnexus/test/integration/resolvers/ruby.test.ts`, update the require_relative test or add a new one:

```typescript
  it('resolves bare require to IMPORTS edge', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const bareRequire = imports.find(e =>
      e.sourceFilePath.includes('base_model.rb') &&
      e.targetFilePath.includes('serializable.rb')
    );
    expect(bareRequire).toBeDefined();
  });
```

- [ ] **Step 3: Run the test — expect PASS** (this should already work if the resolver handles bare require)

```bash
cd gitnexus && npx vitest run test/integration/resolvers/ruby.test.ts --reporter=verbose 2>&1 | tail -30
```

If it fails, investigate `resolveRubyImport` suffix resolution for non-relative paths.

- [ ] **Step 4: Commit**

```bash
git add gitnexus/test/fixtures/lang-resolution/ruby-app/lib/base_model.rb \
       gitnexus/test/integration/resolvers/ruby.test.ts
git commit -m "test(ruby): add bare require import resolution coverage"
```

### Task 6: `prepend` test coverage

The `prepend` test is already covered by Task 4 (Chunk 4), which added `prepend Serializable` to the fixture and asserts the IMPLEMENTS edge with reason `'prepend'`. No additional work needed here.

---

## Chunk 6: Full Suite Verification

### Task 7: Run full test suite and typecheck

- [ ] **Step 1: TypeScript compilation check**

```bash
cd gitnexus && npx tsc --noEmit 2>&1 | tail -20
```

Expected: clean, no errors.

- [ ] **Step 2: Run all Ruby integration tests**

```bash
cd gitnexus && npx vitest run test/integration/resolvers/ruby.test.ts --reporter=verbose
```

Expected: all tests pass.

- [ ] **Step 3: Run full integration suite to check for regressions**

```bash
cd gitnexus && npx vitest run test/integration/ --reporter=verbose 2>&1 | tail -40
```

Expected: no regressions in other language resolvers.

- [ ] **Step 4: Run unit tests**

```bash
cd gitnexus && npx vitest run test/unit/ --reporter=verbose 2>&1 | tail -20
```

Expected: all pass.
