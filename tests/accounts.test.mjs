import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fableOf } from "../bin/usage-api.mjs";
import { emailOf, liveLimitsOf, rateLimitsOf } from "../bin/codex-usage.mjs";
import { defaultUsage, matchEnv, parseModels, parseUsage, slug, usageCommand } from "../bin/models.mjs";

const CCA = fileURLToPath(new URL("../bin/cca", import.meta.url));
const codexUsage = fileURLToPath(new URL("../bin/codex-usage.mjs", import.meta.url));

const codexEvent = JSON.stringify({ type: "event_msg", payload: { rate_limits: {
  primary: { used_percent: 33, window_minutes: 300, resets_at: 1794208378 },
  secondary: { used_percent: 5, window_minutes: 10080, resets_at: 1794795178 },
  plan_type: "plus" } } });

test("cca prints the plan and the Fable window from the usage endpoint's record", () => {
  const home = mkdtempSync(join(tmpdir(), "cca-fable-"));
  const state = `${home}/state/herdr-tower/usage`;
  mkdirSync(state, { recursive: true });
  mkdirSync(`${home}/.claude-accounts/personal`, { recursive: true });
  const fs = { "/.claude.json": '{"oauthAccount":{"emailAddress":"w@x","planDisplayName":"Ultra"}}',
    "/.claude-accounts/personal/.claude.json": '{"oauthAccount":{"emailAddress":"p@x"}}' };
  for (const [f, body] of Object.entries(fs)) writeFileSync(home + f, body);
  writeFileSync(`${state}/default.json`, '{"seven_day":{"used":9,"resets_at":4102444800}}');
  writeFileSync(`${state}/default.api.json`, '{"fetched_at":1,"fable":{"used":3,"resets_at":4102444800}}');
  // A fresh stamp keeps api_refresh from reaching the keychain and the network.
  writeFileSync(`${state}/.api-fetch`, "");
  try {
    const out = execFileSync("sh", [CCA, "--porcelain"],
      { env: { ...process.env, HOME: home, XDG_STATE_HOME: `${home}/state` } }).toString();
    assert.match(out, /^P\tdefault\tUltra$/m);
    assert.match(out, /^U\tdefault\t\t\t9\t4102444800\t3\t4102444800$/m);
    assert.doesNotMatch(out, /^P\tpersonal/m);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// A temp HOME with the usage folder's stamp already fresh, so cca never reaches the network.
const towerHome = (prefix) => {
  const home = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(`${home}/state/herdr-tower/usage`, { recursive: true });
  writeFileSync(`${home}/state/herdr-tower/usage/.api-fetch`, "");
  return home;
};

test("cca use accepts a model id, and an unknown name is refused as no account or agent", () => {
  const home = towerHome("use-model-");
  try {
    writeFileSync(`${home}/state/herdr-tower/models.json`, JSON.stringify([{ id: "gpt", command: "claude-gpt" }]));
    const env = { ...process.env, HOME: home, XDG_STATE_HOME: `${home}/state` };
    const use = (...args) => spawnSync("sh", [CCA, "use", ...args], { env, encoding: "utf8" });

    const chosen = use("gpt");
    assert.equal(chosen.status, 0);
    assert.equal(chosen.stdout.trim(), "gpt");
    assert.equal(readFileSync(`${home}/state/herdr-tower/current`, "utf8").trim(), "gpt");
    const porcelain = spawnSync("sh", [CCA, "--porcelain"], { env, encoding: "utf8" });
    assert.match(porcelain.stdout, /^D\tgpt$/m);

    const unknown = use("nope");
    assert.equal(unknown.status, 3);
    assert.equal(unknown.stderr.trim(), "cca: No account or agent nope.");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a model named codex is usable, while a folder named codex is refused", () => {
  const home = towerHome("use-codex-");
  try {
    writeFileSync(`${home}/state/herdr-tower/models.json`,
      JSON.stringify([{ id: "codex", label: "Codex", command: "claude-gpt" }]));
    const env = { ...process.env, HOME: home, XDG_STATE_HOME: `${home}/state` };
    const run = (...args) => spawnSync("sh", [CCA, ...args], { env, encoding: "utf8" });

    const chosen = run("use", "codex");
    assert.equal(chosen.status, 0);
    assert.equal(chosen.stdout.trim(), "codex");
    assert.equal(run("current").stdout.trim(), "codex");

    const add = run("add", "codex");
    assert.equal(add.status, 2);
    assert.equal(add.stderr.trim(), "codex is a cca command.");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("cca codex add links ~/.codex's config and sessions but leaves auth.json and machine state behind", () => {
  const home = towerHome("codex-add-");
  try {
    mkdirSync(`${home}/.codex/sessions/2026/11/09`, { recursive: true });
    writeFileSync(`${home}/.codex/config.toml`, 'model = "gpt-5"\n');
    writeFileSync(`${home}/.codex/auth.json`, '{"tokens":{"id_token":"x"}}');
    writeFileSync(`${home}/.codex/state.sqlite`, "db");
    writeFileSync(`${home}/.codex/.tmp`, "tmp");
    const env = { ...process.env, HOME: home, XDG_STATE_HOME: `${home}/state` };
    const run = (...args) => spawnSync("sh", [CCA, ...args], { env, encoding: "utf8" });

    const add = run("codex", "add", "work");
    assert.equal(add.status, 0);
    assert.match(add.stdout, /^Created ~\/\.codex-accounts\/work\.$/m);
    assert.match(add.stdout, /^Log in with: CODEX_HOME=~\/\.codex-accounts\/work codex login$/m);

    const dir = `${home}/.codex-accounts/work`;
    assert.equal(readFileSync(`${dir}/config.toml`, "utf8"), 'model = "gpt-5"\n', "the config is linked");
    assert.ok(lstatSync(`${dir}/sessions`).isSymbolicLink(), "the shared session history is a link");
    assert.equal(readlinkSync(`${dir}/sessions`), `${home}/.codex/sessions`);
    assert.ok(lstatSync(`${dir}/archived_sessions`).isSymbolicLink());
    assert.ok(lstatSync(`${dir}/history.jsonl`).isSymbolicLink(), "history is created and shared");
    assert.equal(existsSync(`${dir}/auth.json`), false, "the login is not shared");
    assert.equal(existsSync(`${dir}/state.sqlite`), false, "machine state stays behind");
    assert.equal(existsSync(`${dir}/.tmp`), false);

    assert.equal(run("codex", "add", "work").status, 3, "an existing account folder is refused");
    assert.equal(run("codex", "add", "bad name").status, 2);
    assert.equal(run("codex", "add", "default").status, 2);
    assert.equal(run("codex", "add", "codex").status, 2, "codex is now a cca command");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("cca codex use writes codex-current, refusing a bad name with 2 and a missing account with 3", () => {
  const home = towerHome("codex-use-");
  try {
    mkdirSync(`${home}/.codex-accounts/work`, { recursive: true });
    const env = { ...process.env, HOME: home, XDG_STATE_HOME: `${home}/state` };
    const use = (...args) => spawnSync("sh", [CCA, "codex", "use", ...args], { env, encoding: "utf8" });

    const chosen = use("work");
    assert.equal(chosen.status, 0);
    assert.equal(chosen.stdout.trim(), "work");
    assert.equal(readFileSync(`${home}/state/herdr-tower/codex-current`, "utf8").trim(), "work");
    assert.match(spawnSync("sh", [CCA, "--porcelain"], { env, encoding: "utf8" }).stdout, /^Y\twork$/m);

    assert.equal(use("default").status, 0);
    assert.equal(readFileSync(`${home}/state/herdr-tower/codex-current`, "utf8").trim(), "default");

    const missing = use("nope");
    assert.equal(missing.status, 3);
    assert.equal(missing.stderr.trim(), "cca: No Codex account nope.");
    const bad = use("bad name");
    assert.equal(bad.status, 2);
    assert.equal(bad.stderr.trim(), "cca: Use letters, digits, - or _.");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("cca prints each Codex home's X, V and Q lines with the login from auth.json", () => {
  const home = towerHome("codex-porcelain-");
  try {
    const day = `${home}/.codex/sessions/2026/11/09`;
    mkdirSync(day, { recursive: true });
    writeFileSync(`${day}/rollout-x.jsonl`, `${codexEvent}\n`);
    const token = `h.${Buffer.from(JSON.stringify({ email: "me@x" })).toString("base64url")}.s`;
    writeFileSync(`${home}/.codex/auth.json`, JSON.stringify({ tokens: { id_token: token } }));
    const env = { ...process.env, HOME: home, XDG_STATE_HOME: `${home}/state` };

    const add = spawnSync("sh", [CCA, "--porcelain-add-codex", "work"], { env, encoding: "utf8" });
    assert.equal(add.status, 0);
    assert.equal(add.stdout.trim(), `${home}/.codex-accounts/work`);
    writeFileSync(`${home}/.codex-accounts/work/auth.json`,
      JSON.stringify({ tokens: { id_token: `h.${Buffer.from(JSON.stringify({ email: "work@x" })).toString("base64url")}.s` } }));

    const out = execFileSync("sh", [CCA, "--porcelain"], { env }).toString();
    assert.match(out, /^Y\tdefault$/m);
    assert.match(out, /^X\tdefault\tme@x$/m);
    assert.match(out, /^X\twork\twork@x$/m);
    assert.match(out, /^V\tdefault\t33\t1794208378\t5\t1794795178$/m);
    assert.match(out, /^Q\tdefault\tChatGPT Plus$/m);
    assert.match(out, /^V\twork\t33\t1794208378\t5\t1794795178$/m);
    assert.match(out, /^Q\twork\tChatGPT Plus$/m);

    assert.equal(emailOf(`${home}/.codex`), "me@x");
    const email = spawnSync(process.execPath, [codexUsage, "--email", `${home}/.codex`], { encoding: "utf8" });
    assert.equal(email.status, 0);
    assert.equal(email.stdout.trim(), "me@x");
    const none = spawnSync(process.execPath, [codexUsage, "--email", `${home}/missing`], { encoding: "utf8" });
    assert.equal(none.status, 0);
    assert.equal(none.stdout, "");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("cca's shell hook defines codex() beside claude() and reads codex-current", () => {
  const env = { ...process.env, SHELL: "/bin/sh" };
  const out = execFileSync("sh", [CCA, "shell-init"], { env }).toString();
  assert.match(out, /^claude\(\) \{/m, "the Claude hook stays");
  assert.match(out, /^codex\(\) \{/m);
  assert.match(out, /herdr-tower\/codex-current/);
  assert.match(out, /CODEX_HOME="\$HOME\/\.codex-accounts\/\$_cca_codex" command codex "\$@"/);
});

test("a default model id that is no longer in models.json falls back to default", () => {
  const home = towerHome("current-gone-");
  try {
    const env = { ...process.env, HOME: home, XDG_STATE_HOME: `${home}/state` };
    const current = () => spawnSync("sh", [CCA, "current"], { env, encoding: "utf8" }).stdout.trim();
    writeFileSync(`${home}/state/herdr-tower/models.json`, JSON.stringify([{ id: "gpt", command: "claude-gpt" }]));
    writeFileSync(`${home}/state/herdr-tower/current`, "gpt\n");
    assert.equal(current(), "gpt");
    rmSync(`${home}/state/herdr-tower/models.json`);
    assert.equal(current(), "default");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("models.mjs keeps valid entries and skips invalid ones individually", () => {
  const home = mkdtempSync(join(tmpdir(), "models-parse-"));
  try {
    mkdirSync(join(home, ".claude-accounts", "work"), { recursive: true });
    const text = JSON.stringify([
      { id: "gpt", label: "Codex", command: "claude-gpt", resume: "--resume {id}",
        detect: "ANTHROPIC_BASE_URL=http://127.0.0.1:8317" },
      { id: "Bad Id", command: "x" },
      { id: "default", command: "x" },
      { id: "share", command: "x" },
      { id: "gpt", command: "duplicate" },
      { id: "gemini" },
      { id: "grok", command: "grok\nx" },
      { id: "work", command: "x" },
      { id: "-x", command: "x" },
      "nope",
      { id: "mine", command: " mine ", label: " ", usage: "codex-rollout ~/.codex", resume: "", detect: "BAD" },
      { id: "tabbed", command: "x", label: "Two\tLines\nHere" },
    ]);
    const models = parseModels(text, { home });
    assert.deepEqual(models.map((m) => m.id), ["gpt", "mine", "tabbed"]);
    assert.equal(models[0].command, "claude-gpt");
    assert.equal(models[0].label, "Codex");
    assert.equal(models[0].resume, "--resume {id}");
    assert.equal(models[0].detect, "ANTHROPIC_BASE_URL=http://127.0.0.1:8317");
    assert.equal(models[1].command, "mine");
    assert.equal(models[1].label, undefined);
    assert.equal(models[1].resume, undefined);
    assert.equal(models[1].detect, undefined);
    assert.equal(models[2].label, undefined, "a tab or newline would break the porcelain L line");
    assert.deepEqual(parseModels("{bad", { home }), []);
    assert.deepEqual(parseModels('{"id":"x"}', { home }), []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a model id is its label lower-cased with spaces as dashes", () => {
  assert.equal(slug("My Grok"), "my-grok");
  assert.equal(slug("Gemini 2.5!"), "gemini-25");
  assert.equal(slug("Codex"), "codex");
  assert.equal(slug("!!"), "");
});

test("the first model whose detect line or CCA_ACCOUNT appears in the pane env wins", () => {
  const models = [
    { id: "codex", detect: "ANTHROPIC_BASE_URL=http://127.0.0.1:8317" },
    { id: "gemini", detect: "GEMINI_HOME=/x" },
  ];
  assert.equal(matchEnv(models, ["/usr/bin/claude ANTHROPIC_BASE_URL=http://127.0.0.1:8317 HOME=/x"]), "codex");
  assert.equal(matchEnv(models, ["CCA_ACCOUNT=gemini"]), "gemini");
  assert.equal(matchEnv(models, ["CCA_ACCOUNT=other", "HOME=/x"]), null);
  assert.equal(matchEnv(models, []), null);
  assert.equal(matchEnv([{ id: "a", detect: "X=1" }, { id: "b", detect: "X=2" }], ["X=2", "X=1"]), "a");
});

test("a usage line's five tab fields are read, blanks and all", () => {
  assert.deepEqual(parseUsage("33\t1794208378\t5\t1794795178\tplus\n"),
    { fiveUsed: "33", fiveReset: "1794208378", sevenUsed: "5", sevenReset: "1794795178", plan: "plus" });
  assert.deepEqual(parseUsage("7\t\t\t\tsolo"),
    { fiveUsed: "7", fiveReset: "", sevenUsed: "", sevenReset: "", plan: "solo" });
  assert.equal(parseUsage(""), null);
  assert.equal(parseUsage("\n\t\t\t\t\n"), null);
});

test("the codex-rollout usage word points at the bundled reader", () => {
  assert.equal(usageCommand("codex-rollout ~/.codex", "/mods/x", "/home/u"),
    `'${process.execPath}' '/mods/x/codex-usage.mjs' '/home/u/.codex'`);
  assert.equal(usageCommand("printf hi", "/mods/x", "/home/u"), "printf hi");
});

test("cca lists the models file's entries with their usage and label, the labels file's label last", () => {
  const home = towerHome("models-porcelain-");
  try {
    mkdirSync(`${home}/bin`);
    const ps = `${home}/bin/ps`;
    writeFileSync(ps, "#!/bin/sh\nprintf '%s\\n' '/usr/bin/claude CCA_ACCOUNT=gpt HOME=/x'\n");
    chmodSync(ps, 0o755);
    writeFileSync(`${home}/state/herdr-tower/models.json`, JSON.stringify([
      { id: "gpt", label: "Codex", command: "claude-gpt", resume: "--resume {id}",
        usage: "printf '33\\t1794208378\\t5\\t1794795178\\tplus\\n'",
        detect: "ANTHROPIC_BASE_URL=http://127.0.0.1:8317" },
      { id: "gemini", label: "Gemini", command: "gemini" },
    ]));
    writeFileSync(`${home}/state/herdr-tower/labels`, "gpt\tMy Codex\n");
    const env = { ...process.env, HOME: home, XDG_STATE_HOME: `${home}/state`, CCA_PS: ps };
    const r = spawnSync("sh", [CCA, "--porcelain", "12345"], { env, encoding: "utf8" });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^C\tgpt$/m);
    assert.match(r.stdout, /^M\tgpt\tclaude-gpt\t1$/m);
    assert.match(r.stdout, /^L\tgpt\tCodex$/m, "the file's label reaches the popup");
    assert.match(r.stdout, /^L\tgpt\tMy Codex$/m);
    assert.match(r.stdout, /^U\tgpt\t33\t1794208378\t5\t1794795178\t\t$/m);
    assert.match(r.stdout, /^P\tgpt\tChatGPT Plus$/m);
    assert.match(r.stdout, /^M\tgemini\tgemini\t0$/m);
    assert.match(r.stdout, /^L\tgemini\tGemini$/m);
    assert.doesNotMatch(r.stdout, /^U\tgemini/m);
    assert.doesNotMatch(r.stdout, /^P\tgemini/m);
    assert.ok(r.stdout.indexOf("L\tgpt\tCodex") < r.stdout.indexOf("L\tgpt\tMy Codex"),
      "the app keeps the last L, so the labels file's rename wins over the file's label");
    assert.deepEqual(r.stdout.split("\n").filter(Boolean).map((line) => line.split("\t")[0]),
      ["C", "D", "A", "M", "L", "U", "P", "M", "L", "L"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a codex-rollout usage word reads codex-usage.mjs under the temp HOME", () => {
  const home = towerHome("models-rollout-");
  try {
    const day = `${home}/.codex/sessions/2026/11/09`;
    mkdirSync(day, { recursive: true });
    writeFileSync(`${day}/rollout-x.jsonl`, `${codexEvent}\n`);
    writeFileSync(`${home}/state/herdr-tower/models.json`, JSON.stringify([
      { id: "local-codex", command: "claude-gpt", usage: "codex-rollout ~/.codex" },
    ]));
    const env = { ...process.env, HOME: home, XDG_STATE_HOME: `${home}/state` };
    const out = execFileSync("sh", [CCA, "--porcelain"], { env }).toString();
    assert.match(out, /^M\tlocal-codex\tclaude-gpt\t0$/m);
    assert.match(out, /^U\tlocal-codex\t33\t1794208378\t5\t1794795178\t\t$/m);
    assert.match(out, /^P\tlocal-codex\tChatGPT Plus$/m);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a missing or broken models file adds no model lines and still exits 0", () => {
  const home = towerHome("models-none-");
  try {
    const env = { ...process.env, HOME: home, XDG_STATE_HOME: `${home}/state` };
    const run = () => spawnSync("sh", [CCA, "--porcelain"], { env, encoding: "utf8" });
    let r = run();
    assert.equal(r.status, 0);
    assert.doesNotMatch(r.stdout, /^M\t/m);
    writeFileSync(`${home}/state/herdr-tower/models.json`, "{broken");
    r = run();
    assert.equal(r.status, 0);
    assert.doesNotMatch(r.stdout, /^M\t/m);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("--porcelain-add-model writes the entry and refuses bad ones", () => {
  const home = towerHome("models-add-");
  try {
    const env = { ...process.env, HOME: home, XDG_STATE_HOME: `${home}/state` };
    const add = (...args) => spawnSync("sh", [CCA, "--porcelain-add-model", ...args], { env, encoding: "utf8" });
    const first = add("My Grok", "grok --x");
    assert.equal(first.status, 0);
    assert.equal(first.stdout.trim(), "my-grok");
    const file = `${home}/state/herdr-tower/models.json`;
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")),
      [{ id: "my-grok", label: "My Grok", command: "grok --x" }]);
    const duplicate = add("My Grok", "grok --x");
    assert.equal(duplicate.status, 2);
    assert.doesNotMatch(duplicate.stderr.trim(), /\.$/, "a refusal is one line without a full stop");
    assert.equal(add("default", "x").status, 2);
    assert.equal(add("share", "x").status, 2);
    assert.equal(add("Bad", "one\ntwo").status, 2);
    assert.equal(add("No command", "").status, 2);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).length, 1);

    const account = spawnSync("sh", [CCA, "add", "my-grok"], { env, encoding: "utf8" });
    assert.equal(account.status, 2);
    assert.match(account.stderr, /my-grok is a model/);

    const rename = spawnSync("sh", [CCA, "--porcelain-rename", "my-grok", "Grok"], { env, encoding: "utf8" });
    assert.equal(rename.status, 0);
    assert.match(readFileSync(`${home}/state/herdr-tower/labels`, "utf8"), /^my-grok\tGrok$/m);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("adding a codex command stores the codex-rollout usage, another command does not", () => {
  const home = towerHome("models-codex-");
  try {
    const env = { ...process.env, HOME: home, XDG_STATE_HOME: `${home}/state` };
    const add = (...args) => spawnSync("sh", [CCA, "--porcelain-add-model", ...args], { env, encoding: "utf8" });
    assert.equal(add("Codex", "codex").status, 0);
    assert.equal(add("Local Codex", "/usr/local/bin/codex --x").status, 0);
    assert.equal(add("GPT", "claude-gpt").status, 0);
    const entries = JSON.parse(readFileSync(`${home}/state/herdr-tower/models.json`, "utf8"));
    assert.deepEqual(entries.map((m) => [m.id, m.usage]), [
      ["codex", "codex-rollout ~/.codex"],
      ["local-codex", "codex-rollout ~/.codex"],
      ["gpt", undefined],
    ]);
    assert.equal(defaultUsage("codex"), "codex-rollout ~/.codex");
    assert.equal(defaultUsage("bin/codex --full-auto"), "codex-rollout ~/.codex");
    assert.equal(defaultUsage("codex-cli"), null);
    assert.equal(defaultUsage("claude-gpt"), null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ps -E shows no environment in the test sandbox, so CCA_PS points at a stub printing the pane's line.
const paneOut = (lineOf, models) => {
  const home = mkdtempSync(join(tmpdir(), "pane-"));
  try {
    mkdirSync(`${home}/state/herdr-tower/usage`, { recursive: true });
    writeFileSync(`${home}/state/herdr-tower/usage/.api-fetch`, "");
    mkdirSync(`${home}/.claude-accounts/work`, { recursive: true });
    mkdirSync(`${home}/bin`);
    if (models !== undefined) writeFileSync(`${home}/state/herdr-tower/models.json`, models);
    const ps = `${home}/bin/ps`;
    writeFileSync(ps, `#!/bin/sh\nprintf '%s\\n' "${lineOf(home)}"\n`);
    chmodSync(ps, 0o755);
    const env = { ...process.env, HOME: home, XDG_STATE_HOME: `${home}/state`, CCA_PS: ps };
    return execFileSync("sh", [CCA, "--porcelain", "12345"], { env })
      .toString().split("\n")[0];
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
};

test("cca reads a pane whose environment matches a model's detect as that model", () => {
  const models = JSON.stringify([
    { id: "gpt", command: "claude-gpt", detect: "ANTHROPIC_BASE_URL=http://127.0.0.1:8317" },
  ]);
  assert.equal(paneOut(() => "/usr/bin/claude ANTHROPIC_BASE_URL=http://127.0.0.1:8317 HOME=/x", models), "C\tgpt");
});

test("cca reads CCA_ACCOUNT=<model id> as that model, over the pane's config dir too", () => {
  const models = JSON.stringify([{ id: "gemini", command: "gemini" }]);
  assert.equal(paneOut(() => "/usr/bin/claude CCA_ACCOUNT=gemini HOME=/x", models), "C\tgemini");
  assert.equal(paneOut((home) => `/usr/bin/claude CCA_ACCOUNT=gemini CLAUDE_CONFIG_DIR=${home}/.claude-accounts/work HOME=/x`, models),
    "C\tgemini");
});

test("cca names the current account from the pane's config dir", () => {
  assert.equal(paneOut((home) => `/usr/bin/claude CCA_ACCOUNT=work CLAUDE_CONFIG_DIR=${home}/.claude-accounts/work HOME=/x`),
    "C\twork");
});

test("cca reads a pane without markers as the default account", () => {
  assert.equal(paneOut(() => "/usr/bin/claude HOME=/x"), "C\tdefault");
});

test("the Codex usage reads the last event with a window and skips a cut line", () => {
  const line = (payload) => JSON.stringify({ type: "event_msg", payload });
  const text = [
    '{"type":"event_msg","payload":{"rate_', // the tail read can start mid-line
    line({ rate_limits: { primary: { used_percent: 1, resets_at: 10 }, secondary: null, plan_type: "plus" } }),
    line({ rate_limits: null }),
    codexEvent,
    line({ rate_limits: { primary: null, secondary: null, plan_type: "plus" } }),
  ].join("\n");
  assert.deepEqual(rateLimitsOf(text),
    { five: { used: 33, resets_at: 1794208378 }, seven: { used: 5, resets_at: 1794795178 }, plan: "plus" });
  assert.deepEqual(rateLimitsOf(line({ rate_limits: { secondary: { used_percent: 4.5 } } })),
    { five: null, seven: { used: 4.5, resets_at: null }, plan: null });
  assert.equal(rateLimitsOf(line({ rate_limits: null })), null);
  assert.equal(rateLimitsOf('{"type":"event_msg","payload":{"rate_'), null, "a cut line is skipped");
  assert.equal(rateLimitsOf(""), null);
});

test("the live Codex usage reads the endpoint's two windows and plan", () => {
  const body = { plan_type: "plus", rate_limit: {
    primary_window: { used_percent: 12, limit_window_seconds: 18000, reset_at: 1795503838 },
    secondary_window: { used_percent: 5, limit_window_seconds: 604800, reset_at: 1796035163 } } };
  assert.deepEqual(liveLimitsOf(body),
    { five: { used: 12, resets_at: 1795503838 }, seven: { used: 5, resets_at: 1796035163 }, plan: "plus" });
  assert.deepEqual(liveLimitsOf({ rate_limit: { primary_window: null, secondary_window: { used_percent: 0 } } }),
    { five: null, seven: { used: 0, resets_at: null }, plan: null });
  assert.equal(liveLimitsOf({ rate_limit: { primary_window: null, secondary_window: null } }), null);
  assert.equal(liveLimitsOf({}), null);
});

test("codex-usage prints the rollout's five fields, and nothing when there is no data", () => {
  const home = mkdtempSync(join(tmpdir(), "codex-usage-"));
  try {
    const day = join(home, "sessions", "2026", "11", "09");
    mkdirSync(day, { recursive: true });
    writeFileSync(join(day, "rollout-x.jsonl"), `${codexEvent}\n`);
    const run = spawnSync(process.execPath, [codexUsage, home], { encoding: "utf8" });
    assert.equal(run.status, 0);
    assert.equal(run.stdout, "33\t1794208378\t5\t1794795178\tplus\n");

    const empty = mkdtempSync(join(tmpdir(), "codex-empty-"));
    try {
      mkdirSync(join(empty, "sessions"), { recursive: true });
      const none = spawnSync(process.execPath, [codexUsage, empty], { encoding: "utf8" });
      assert.equal(none.status, 0);
      assert.equal(none.stdout, "");
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// The shape /api/oauth/usage answered for an Ultra and a Max account on 2026-11-06, trimmed to the fields read.
test("the Fable week is read from the usage endpoint's weekly_scoped row", () => {
  const ultra = { five_hour: null, seven_day: { utilization: 9.0, resets_at: "2026-11-12T17:59:59.698736+00:00" },
    limits: [
      { kind: "weekly_all", group: "weekly", percent: 9, severity: "normal", resets_at: "2026-11-12T17:59:59.698736+00:00", scope: null, is_active: true },
      { kind: "weekly_scoped", group: "weekly", percent: 0, severity: "normal", resets_at: "2026-11-12T18:00:00+00:00",
        scope: { model: { id: null, display_name: "Fable" }, surface: null }, is_active: false },
    ] };
  assert.deepEqual(fableOf(ultra), { used: 0, resets_at: Date.parse("2026-11-12T18:00:00Z") / 1000 });
  const max = { limits: [
    { kind: "session", group: "session", percent: 4, resets_at: "2026-11-06T09:49:59.879011+00:00", scope: null },
    { kind: "weekly_scoped", group: "weekly", percent: 37, resets_at: "bad", scope: { model: { display_name: "fable" } } },
  ] };
  assert.deepEqual(fableOf(max), { used: 37, resets_at: null });
  assert.equal(fableOf({ limits: [{ kind: "weekly_scoped", percent: 5, scope: { model: { display_name: "Opus" } } }] }), null);
  assert.equal(fableOf({}), null);
});

test("usage-api exits 1 on unreadable credentials, also from a path a file URL would escape", () => {
  const dir = mkdtempSync(join(tmpdir(), "usage api "));
  const copy = join(dir, "usage-api.mjs");
  copyFileSync(new URL("../bin/usage-api.mjs", import.meta.url), copy);
  try {
    const run = spawnSync(process.execPath, [copy], { input: "{bad", encoding: "utf8" });
    assert.equal(run.status, 1, "a silent exit 0 would let cca overwrite the last record with nothing");
    assert.equal(run.stdout, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a custom command may keep the id codex, since only account folder names are cca commands", () => {
  const home = mkdtempSync(join(tmpdir(), "cca-models-codex-"));
  try {
    const text = JSON.stringify([{ id: "codex", label: "Codex", command: "claude-gpt" }]);
    assert.deepEqual(parseModels(text, { home }).map((m) => m.id), ["codex"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a model that reads Codex usage reports that login's email on an E line of its own", () => {
  const home = towerHome("model-login-");
  try {
    mkdirSync(`${home}/.codex`, { recursive: true });
    const token = `h.${Buffer.from(JSON.stringify({ email: "me@x" })).toString("base64url")}.s`;
    writeFileSync(`${home}/.codex/auth.json`, JSON.stringify({ tokens: { id_token: token } }));
    writeFileSync(`${home}/state/herdr-tower/models.json`, JSON.stringify([
      { id: "codex", label: "Codex", command: "claude-gpt", usage: "codex-rollout ~/.codex" },
      { id: "plain", command: "claude-other" },
      { id: "gone", command: "claude-gone", usage: "codex-rollout ~/missing" },
    ]));
    const env = { ...process.env, HOME: home, XDG_STATE_HOME: `${home}/state` };
    const out = execFileSync("sh", [CCA, "--porcelain"], { env }).toString();
    assert.match(out, /^M\tcodex\tclaude-gpt\t0$/m, "the M line keeps its four fields");
    assert.match(out, /^E\tcodex\tme@x$/m);
    assert.doesNotMatch(out, /^E\tplain\t/m, "a model without a Codex reader has no login");
    assert.doesNotMatch(out, /^E\tgone\t/m, "a Codex home without auth.json has no login");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("cca launch reads the one start command, falling back to the layouts' old files until one is saved", () => {
  const home = towerHome("launch-");
  try {
    const env = { ...process.env, HOME: home, XDG_STATE_HOME: `${home}/state` };
    const tower = `${home}/state/herdr-tower`;
    const launch = (...args) => spawnSync("sh", [CCA, "launch", ...args], { env, encoding: "utf8" });

    mkdirSync(tower, { recursive: true });
    assert.equal(launch().stdout, "");
    writeFileSync(`${tower}/arcade-launch`, "claude\n");
    writeFileSync(`${tower}/chiikawa-launch`, "  ccode  \n");
    assert.equal(launch().stdout, "ccode\n");

    assert.equal(launch("set", " ccode -m fmax ").status, 0);
    assert.equal(readFileSync(`${tower}/launch`, "utf8"), "ccode -m fmax\n");
    assert.equal(launch().stdout, "ccode -m fmax\n");

    // A saved empty command means claude, not the old files.
    assert.equal(launch("set", "").status, 0);
    assert.equal(launch().stdout, "");

    assert.equal(launch("set", "a\tb").status, 2);
    assert.equal(launch("set", "a\nb").status, 2);
    assert.equal(launch("bogus").status, 2);
    assert.equal(readFileSync(`${tower}/launch`, "utf8"), "\n");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
