/**
 * sns-validator ships no type declarations and has no @types package.
 *
 * Invariant this protects: the SNS import specifier must stay LITERAL. esbuild
 * can only follow a literal specifier, and the api runtime image is a single
 * bundle with no node_modules — the previous `const pkg = "sns-validator";
 * import(pkg)` workaround (written only to dodge TS2307) stayed a runtime
 * import, so every SES/SNS bounce/complaint webhook 403'd in production.
 * Declaring the module here keeps the literal specifier without a call-site
 * `@ts-expect-error`, which would itself break the build the day a @types
 * package appears (unused-directive error).
 */
declare module "sns-validator";
