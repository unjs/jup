/**
 * What the transform rewrites, and why each rewrite is allowed.
 *
 * Every rule is **expression-local** and **type-preserving**: it replaces one
 * expression with another of the same static type, so the tree `scriptc` sees
 * type-checks exactly as `src/` does. `compile-transform.mjs --typecheck` is
 * what enforces that — it runs the repo's own `tsc` over the rewritten tree, so
 * an unsound rule fails loudly instead of quietly changing the program.
 *
 * Rules that would need to move a binding, add a statement or change control
 * flow are deliberately absent; see the table at the bottom of this file for
 * the ones that were considered and rejected.
 *
 * Each rule is `{ name, why, match(node, ctx) }`. `match` returns an edit
 * `{ start, end, text, helpers? }` or `undefined`. `helpers` names the
 * `__compat.ts` exports the edit needs, which `compile-transform.mjs` hoists
 * into the file's preamble.
 */

/** Node is `<Identifier>.<name>`, e.g. `URL.canParse`. */
function isStaticMember(node, object, property) {
  return (
    node?.type === "MemberExpression" &&
    node.computed === false &&
    node.object?.type === "Identifier" &&
    node.object.name === object &&
    node.property?.type === "Identifier" &&
    node.property.name === property
  );
}

/** Node is `Object.prototype.hasOwnProperty.call`. */
function isHasOwnPropertyCall(node) {
  return (
    node?.type === "MemberExpression" &&
    node.property?.type === "Identifier" &&
    node.property.name === "call" &&
    node.object?.type === "MemberExpression" &&
    node.object.property?.type === "Identifier" &&
    node.object.property.name === "hasOwnProperty" &&
    isStaticMember(node.object.object, "Object", "prototype")
  );
}

/**
 * `.origin` is rewritten only on `new URL(...)`, which is the one receiver that
 * is provably a URL without type information.
 *
 * A bare identifier is not enough, and `--typecheck` is how we found that out:
 * `origin` is also §05.3's name for *where an npmrc setting came from*, so
 * `entry.origin` and `npmrc.cafile.origin` are `NpmrcOrigin`, not URLs — and one
 * of them is an assignment target, which the rewrite turned into a call on the
 * left of an `=`. Three real `url.origin` blockers are left standing as the
 * price of a rule that cannot be wrong.
 */
function isUrlReceiver(node) {
  return (
    node?.type === "NewExpression" &&
    node.callee?.type === "Identifier" &&
    node.callee.name === "URL"
  );
}

export const RULES = [
  {
    name: "canParse",
    why: "`URL.canParse` has no lowering; a try/catch around the constructor does.",
    match(node, ctx) {
      if (node.type !== "CallExpression" || !isStaticMember(node.callee, "URL", "canParse")) return;
      // Only the callee is replaced, so a rewrite inside the argument still applies.
      return { start: node.callee.start, end: node.callee.end, text: ctx.helper("canParse") };
    },
  },
  {
    name: "origin",
    why: "`URL.origin` has no lowering; `protocol` and `host` both do.",
    match(node, ctx) {
      if (node.type !== "MemberExpression" || node.computed) return;
      if (node.property?.type !== "Identifier" || node.property.name !== "origin") return;
      if (!isUrlReceiver(node.object)) return;
      const receiver = ctx.text(node.object);
      return {
        start: node.start,
        end: node.end,
        text: `${ctx.helper("origin")}(${receiver})`,
        encloses: node.object,
      };
    },
  },
  {
    name: "hasOwn",
    why: "`Object.hasOwn` and `hasOwnProperty.call` are both unsupported; `Object.keys().includes()` is not.",
    match(node, ctx) {
      if (node.type !== "CallExpression") return;
      const direct = isStaticMember(node.callee, "Object", "hasOwn");
      if (!direct && !isHasOwnPropertyCall(node.callee)) return;
      if (node.arguments.length !== 2) return;
      return { start: node.callee.start, end: node.callee.end, text: ctx.helper("hasOwn") };
    },
  },
  {
    name: "startsWithAt",
    why: "`String.prototype.startsWith` has no lowering for its second argument.",
    match(node, ctx) {
      if (node.type !== "CallExpression" || node.arguments.length !== 2) return;
      const callee = node.callee;
      if (callee?.type !== "MemberExpression" || callee.computed) return;
      if (callee.property?.type !== "Identifier" || callee.property.name !== "startsWith") return;
      const receiver = ctx.text(callee.object);
      const search = ctx.text(node.arguments[0]);
      const at = ctx.text(node.arguments[1]);
      return {
        start: node.start,
        end: node.end,
        text: `${ctx.helper("startsWithAt")}(${receiver}, ${search}, ${at})`,
        encloses: node,
      };
    },
  },
  {
    name: "flat",
    why: "`Array.prototype.flat` has no lowering; the loop it stands for does.",
    match(node, ctx) {
      if (node.type !== "CallExpression" || node.arguments.length !== 0) return;
      const callee = node.callee;
      if (callee?.type !== "MemberExpression" || callee.computed) return;
      if (callee.property?.type !== "Identifier" || callee.property.name !== "flat") return;
      return {
        start: node.start,
        end: node.end,
        text: `${ctx.helper("flat")}(${ctx.text(callee.object)})`,
        encloses: node,
      };
    },
  },
  {
    name: "statOrUndefined",
    why: "`statSync` has no lowering for its options argument; the `Stats | undefined` it returns is what a try/catch returns.",
    match(node, ctx) {
      if (node.type !== "CallExpression" || node.arguments.length !== 2) return;
      if (node.callee?.type !== "Identifier" || node.callee.name !== "statSync") return;
      // `{ throwIfNoEntry: false }` is the only options object this stands in for.
      if (!ctx.text(node.arguments[1]).includes("throwIfNoEntry")) return;
      return {
        start: node.start,
        end: node.end,
        text: `${ctx.helper("statOrUndefined")}(${ctx.text(node.arguments[0])})`,
        encloses: node,
      };
    },
  },
];

/**
 * Considered and left out. Each one needs more than an expression swap, so it
 * belongs in `src/` (where the tests can see it) or nowhere.
 *
 *   `url.username` / `.password`      reads *and* writes, and the writes mutate
 *   (13 sites, §14.8 redaction)       a `const` binding — a transform cannot
 *                                     rewrite `url.username = ""` without
 *                                     restructuring the function.
 *   `process.getBuiltinModule(m)`     its type is `typeof import(m)`; a record
 *   (7 sites, net/proxy.ts)           literal of the members actually used is a
 *                                     different type, and two of the sites take
 *                                     the union of two such modules.
 *   `rm(p, { recursive, force })`     the replacement is a hand-written
 *   (3 sites)                         recursive delete — real code, with its own
 *                                     bugs, in a file no test runs.
 *   `Date.parse`, `fromCodePoint`     same: a date parser and a surrogate-pair
 *   (4 sites)                         encoder are programs, not rewrites.
 *   `Object.defineProperty`           the natural replacement, `error.cause = x`,
 *   (2 sites, errors.ts)              is itself unsupported (SC1090).
 */
