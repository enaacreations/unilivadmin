import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";
import esbuildPluginPino from "esbuild-plugin-pino";
import { readFile, rm } from "node:fs/promises";
import { builtinModules } from "node:module";

// Plugins (e.g. 'esbuild-plugin-pino') may use `require` to resolve dependencies
globalThis.require = createRequire(import.meta.url);

const artifactDir = path.dirname(fileURLToPath(import.meta.url));

/** Docker / production images log JSON to stdout — no pino-pretty worker threads. */
const prodBundle = process.env.API_BUNDLE_TARGET === "production";

/**
 * Post-build bundle verification (see `verifyBundle`).
 *  - "strict" → a violation fails the build. Use this in CI and in the Docker
 *    image build; it is the only setting that actually stops a broken image.
 *  - anything else (default) → report loudly and continue, so a local build is
 *    never blocked by a package another workstream still has to make literal.
 */
const verifyMode = process.env.API_BUNDLE_VERIFY === "strict" ? "strict" : "warn";

/**
 * Packages that MUST end up inside the bundle, keyed by a symbol that only that
 * package emits. The runtime image has no node_modules, so "resolvable at
 * runtime" is not a thing: if the symbol is absent, the feature throws
 * ERR_MODULE_NOT_FOUND on first use. This is the check the previous recipe got
 * wrong — it asserted a `grep -c "import(pkg)"` COUNT, which is satisfied by any
 * number of unbundled packages and named none of them, so sns-validator sat
 * unbundled behind a passing check while every SES/SNS bounce webhook 403'd.
 */
const REQUIRED_IN_BUNDLE = {
  "@aws-sdk/client-sesv2": "SESv2ServiceException", // notify-core providers.ts (EMAIL_PROVIDER=ses)
  nodemailer: "SMTPConnection", // notify-core providers.ts (SMTP_HOST)
  "sns-validator": "signableKeysForSubscription", // routes/webhooks.ts verifySns
};

/**
 * The ONLY packages allowed to remain runtime imports. Each is externalized on
 * purpose, is off unless explicitly configured, and degrades cleanly (a caught
 * throw + a log) rather than silently breaking a request path. Anything else
 * reaching the runtime-import list is a defect — add the package to the bundle
 * and make its specifier LITERAL, do not add it here.
 */
const OPTIONAL_RUNTIME_IMPORTS = {
  ioredis: "notify-core/queue.ts — only loaded when REDIS_URL is set; callers fall back to inline delivery on throw",
  bullmq: "notify-core/queue.ts — only loaded when REDIS_URL is set; callers fall back to inline delivery on throw",
  "web-push": "lib/web-push.ts — only loaded when VAPID_* are set; pushToUser catches and logs, never throws",
  "pg-native": "pg's lazy `pg.native` getter — not installed, never touched by us; the getter swallows MODULE_NOT_FOUND",
  "supports-color": "debug's optional colour probe — not installed, wrapped in its own try/catch, falls back to default colours",
};

const NODE_BUILTINS = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);

/**
 * Every module the bundle still has to resolve at RUNTIME, with the source shape
 * that produced it. Covers all three shapes esbuild can leave behind:
 *  - `const pkg = "x"; await import(pkg)` — a variable specifier esbuild cannot follow;
 *  - `await import("x")` — a literal import of an externalized package;
 *  - `import … from "x"` / `__require("x")` — a static import of an externalized package.
 */
function runtimeImportsIn(code) {
  const found = new Map();
  const add = (spec, shape) => {
    if (!spec || spec.startsWith(".") || spec.startsWith("/") || NODE_BUILTINS.has(spec)) return;
    if (!found.has(spec)) found.set(spec, shape);
  };

  // Shape 1: identifiers passed to import(), resolved back to their string literal.
  const idents = new Set([...code.matchAll(/\bimport\(\s*([A-Za-z_$][\w$]*)\s*\)/g)].map((m) => m[1]));
  for (const id of idents) {
    const assigns = code.matchAll(new RegExp(`\\b${id}\\s*=\\s*["']([^"']+)["']`, "g"));
    let seen = false;
    for (const m of assigns) {
      seen = true;
      add(m[1], `variable specifier — const ${id} = "${m[1]}"; import(${id})`);
    }
    if (!seen) found.set(`<unresolved import(${id})>`, "variable specifier with no literal assignment — inspect by hand");
  }
  // Shapes 2 and 3: literal specifiers left external.
  for (const m of code.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) add(m[1], "dynamic import of an external");
  for (const m of code.matchAll(/^import[^;\n]*?from\s*["']([^"']+)["']/gm)) add(m[1], "static import of an external");
  for (const m of code.matchAll(/\b__require\(\s*["']([^"']+)["']\s*\)/g)) add(m[1], "require() of an external");
  return found;
}

/**
 * Asserts the two halves of the invariant "the runtime image needs no
 * node_modules": every REQUIRED_IN_BUNDLE package is actually inlined, and every
 * module still resolved at runtime is on the OPTIONAL_RUNTIME_IMPORTS list.
 * Returns the violations so the caller decides whether to fail.
 */
async function verifyBundle(bundlePath) {
  const code = await readFile(bundlePath, "utf8");
  const violations = [];

  for (const [pkg, symbol] of Object.entries(REQUIRED_IN_BUNDLE)) {
    if (!code.includes(symbol)) {
      violations.push(
        `${pkg} is NOT bundled (no "${symbol}" in the output). esbuild can only follow a LITERAL ` +
          `import specifier — replace \`const pkg = "${pkg}"; await import(pkg)\` with ` +
          `\`await import("${pkg}")\` at its call site, or add ${pkg} to OPTIONAL_RUNTIME_IMPORTS ` +
          `if it is genuinely optional and fails cleanly.`,
      );
    }
  }

  const runtime = runtimeImportsIn(code);
  console.log("Runtime module resolutions left in the bundle:");
  for (const [spec, shape] of [...runtime].sort()) {
    const reason = OPTIONAL_RUNTIME_IMPORTS[spec];
    console.log(`  ${reason ? "ok  " : "BAD "} ${spec.padEnd(24)} ${reason ?? shape}`);
    if (!reason) violations.push(`${spec} is resolved at runtime but the image has no node_modules (${shape}).`);
  }
  return violations;
}

async function buildAll() {
  const distDir = path.resolve(artifactDir, "dist");
  await rm(distDir, { recursive: true, force: true });

  await esbuild({
    entryPoints: [path.resolve(artifactDir, "src/index.ts")],
    platform: "node",
    bundle: true,
    format: "esm",
    outdir: distDir,
    outExtension: { ".js": ".mjs" },
    logLevel: "info",
    // Some packages may not be bundleable, so we externalize them, we can add more here as needed.
    // Some of the packages below may not be imported or installed, but we're adding them in case they are in the future.
    // Examples of unbundleable packages:
    // - uses native modules and loads them dynamically (e.g. sharp)
    // - use path traversal to read files (e.g. @google-cloud/secret-manager loads sibling .proto files)
    external: [
      "*.node",
      "sharp",
      "better-sqlite3",
      "sqlite3",
      "canvas",
      "bcrypt",
      "argon2",
      "fsevents",
      "re2",
      "farmhash",
      "xxhash-addon",
      "bufferutil",
      "utf-8-validate",
      "ssh2",
      "cpu-features",
      "dtrace-provider",
      "isolated-vm",
      "lightningcss",
      "pg-native",
      "oracledb",
      "mongodb-client-encryption",
      // NOTE: nodemailer is NOT externalized — see the @aws-sdk note below. It is
      // a dependency of @workspace/notify-core and the ONLY way SMTP_HOST works
      // in the slim image; externalizing it made the documented SMTP remedy a
      // guaranteed ERR_MODULE_NOT_FOUND at first send. (twilio is gone entirely:
      // notify-core now calls the Twilio REST API over fetch, no SDK.)
      "web-push",
      "bullmq",
      "ioredis",
      "handlebars",
      "knex",
      "typeorm",
      "protobufjs",
      "onnxruntime-node",
      "@tensorflow/*",
      "@prisma/client",
      "@mikro-orm/*",
      "@grpc/*",
      "@swc/*",
      // NOTE: @aws-sdk/* and sns-validator are intentionally NOT externalized —
      // the api runtime image ships no node_modules (self-contained esbuild
      // bundle), so the AWS SDK (S3/R2 storage in @workspace/storage, SES in
      // notify-core) and the SES/SNS webhook signature validator must be bundled
      // in, not left as unresolvable runtime imports. Both are pure JS.
      // Omission from this list is necessary but NOT sufficient: esbuild can only
      // follow a LITERAL import specifier. `const pkg = "…"; await import(pkg)`
      // silently stays a runtime import and is missing from the image — which is
      // exactly how SES shipped broken. `verifyBundle` below enforces both halves;
      // do not add a package there without also making its specifier literal.
      "@azure/*",
      "@opentelemetry/*",
      "@google-cloud/*",
      "@google/*",
      "googleapis",
      "firebase-admin",
      "@parcel/watcher",
      "@sentry/profiling-node",
      "@tree-sitter/*",
      "aws-sdk",
      "classic-level",
      "dd-trace",
      "ffi-napi",
      "grpc",
      "hiredis",
      "kerberos",
      "leveldown",
      "miniflare",
      "mysql2",
      "newrelic",
      "odbc",
      "piscina",
      "realm",
      "ref-napi",
      "rocksdb",
      "sass-embedded",
      "sequelize",
      "serialport",
      "snappy",
      "tinypool",
      "usb",
      "workerd",
      "wrangler",
      "zeromq",
      "zeromq-prebuilt",
      "playwright",
      "puppeteer",
      "puppeteer-core",
      "electron",
    ],
    sourcemap: "linked",
    plugins: prodBundle
      ? []
      : [
          // Dev/local bundles only: pino-pretty uses worker threads whose paths are
          // resolved relative to the build output dir. Production Docker runs from a
          // different WORKDIR, so skip the plugin there (logger.ts already avoids
          // pino-pretty when NODE_ENV=production).
          esbuildPluginPino({ transports: ["pino-pretty"] }),
        ],
    // Make sure packages that are cjs only (e.g. express) but are bundled continue to work in our esm output file
    banner: {
      js: `import { createRequire as __bannerCrReq } from 'node:module';
import __bannerPath from 'node:path';
import __bannerUrl from 'node:url';

globalThis.require = __bannerCrReq(import.meta.url);
globalThis.__filename = __bannerUrl.fileURLToPath(import.meta.url);
globalThis.__dirname = __bannerPath.dirname(globalThis.__filename);
    `,
    },
  });

  const violations = await verifyBundle(path.join(distDir, "index.mjs"));
  if (!violations.length) {
    console.log("Bundle verification passed — the image needs no node_modules.");
    return;
  }
  console.error(`\nBundle verification FAILED (${violations.length}):`);
  for (const v of violations) console.error(`  - ${v}`);
  if (verifyMode === "strict") {
    throw new Error("bundle verification failed (API_BUNDLE_VERIFY=strict)");
  }
  console.error(
    "\nThese are production outages, not style nits: the runtime image ships no\n" +
      "node_modules, so each of the above throws ERR_MODULE_NOT_FOUND on first use.\n" +
      "Set API_BUNDLE_VERIFY=strict to make this fail the build.\n",
  );
}

buildAll().catch((err) => {
  console.error(err);
  process.exit(1);
});
