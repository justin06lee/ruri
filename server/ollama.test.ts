import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import type { ModelChoice } from "../shared/protocol.js";
import { localModel, lookLocal, ollamaOrigin, servingLocal, sizeLocal } from "./ollama.js";
import { localChoices } from "./providers.js";

/** A stand-in Ollama: what it holds, what it says of each, what it was asked to make. */
interface Stand {
  models: Array<{
    name: string;
    modified_at: string;
    capabilities?: string[];
    parameters?: string;
    context?: number;
  }>;
  created: Array<{ model: string; from: string; parameters: { num_ctx: number } }>;
  shows: string[];
}

const stand: Stand = { models: [], created: [], shows: [] };
let server: http.Server;
const before = { origin: process.env["RURI_OLLAMA"], ctx: process.env["RURI_OLLAMA_CTX"] };

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      const json = (value: unknown, status = 200) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(value));
      };
      if (req.url === "/api/tags") {
        return json({
          models: stand.models.map((m) => ({
            name: m.name,
            model: m.name,
            modified_at: m.modified_at,
            // a model's digest moves when what is written into it does
            digest: `${m.name}@${m.modified_at}@${m.parameters ?? ""}`,
          })),
        });
      }
      if (req.url === "/api/show") {
        const asked = (JSON.parse(body) as { model: string }).model;
        stand.shows.push(asked);
        const model = stand.models.find((m) => m.name === asked);
        if (!model) return json({ error: "not found" }, 404);
        return json({
          ...(model.capabilities ? { capabilities: model.capabilities } : {}),
          ...(model.parameters ? { parameters: model.parameters } : {}),
          model_info: model.context ? { "qwen35.context_length": model.context } : {},
        });
      }
      if (req.url === "/api/create") {
        const { model, from: source, parameters } = JSON.parse(body) as Stand["created"][number];
        const asked = { model, from: source, parameters };
        stand.created.push(asked);
        const from = stand.models.find((m) => m.name === asked.from);
        stand.models = stand.models.filter((m) => m.name !== asked.model);
        stand.models.push({
          name: asked.model,
          modified_at: new Date().toISOString(),
          ...(from?.capabilities ? { capabilities: from.capabilities } : {}),
          parameters: `num_ctx                        ${asked.parameters.num_ctx}\ntemperature                    1`,
          ...(from?.context ? { context: from.context } : {}),
        });
        return json({ status: "success" });
      }
      json({ error: "no such route" }, 404);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env["RURI_OLLAMA"] = `127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(() => {
  stand.models = [];
  stand.created = [];
  stand.shows = [];
  delete process.env["RURI_OLLAMA_CTX"];
});

afterAll(() => {
  server.close();
  for (const [key, value] of [
    ["RURI_OLLAMA", before.origin],
    ["RURI_OLLAMA_CTX", before.ctx],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const CHAT = ["completion", "tools", "thinking"];
const OLD = "2026-01-01T00:00:00Z";

describe("where Ollama is", () => {
  test("its usual place unless told, and nowhere when told nothing", () => {
    const set = process.env["RURI_OLLAMA"];
    delete process.env["RURI_OLLAMA"];
    expect(ollamaOrigin()).toBe("http://127.0.0.1:11434");
    process.env["RURI_OLLAMA"] = "";
    expect(ollamaOrigin()).toBeUndefined();
    process.env["RURI_OLLAMA"] = "https://box.example:1/";
    expect(ollamaOrigin()).toBe("https://box.example:1");
    process.env["RURI_OLLAMA"] = set;
  });

  test("no Ollama answering is no local models, not an error", async () => {
    const set = process.env["RURI_OLLAMA"];
    process.env["RURI_OLLAMA"] = "127.0.0.1:9";
    expect(await lookLocal()).toEqual([]);
    process.env["RURI_OLLAMA"] = "";
    expect(await lookLocal()).toEqual([]);
    process.env["RURI_OLLAMA"] = set;
  });
});

describe("what a chat on a local model is served by", () => {
  test("a model with no window of its own is served by a copy with room, made when first asked for", async () => {
    stand.models = [{ name: "bonsai-2:latest", modified_at: OLD, capabilities: CHAT, context: 262_144 }];
    expect(await lookLocal()).toEqual([
      {
        name: "bonsai-2:latest",
        serve: "bonsai-2:latest-ruri",
        window: 32_768,
        tools: true,
        vision: false,
        thinking: true,
      },
    ]);
    // looking makes nothing: a model nobody uses is never copied
    expect(stand.created).toEqual([]);
    expect(await sizeLocal("bonsai-2:latest")).toBe("bonsai-2:latest-ruri");
    expect(stand.created).toEqual([
      { model: "bonsai-2:latest-ruri", from: "bonsai-2:latest", parameters: { num_ctx: 32_768 } },
    ]);
    // and once is enough, this run and the next look
    expect(servingLocal("bonsai-2:latest")).toBe("bonsai-2:latest-ruri");
    await lookLocal();
    expect(await sizeLocal("bonsai-2:latest")).toBe("bonsai-2:latest-ruri");
    expect(stand.created).toHaveLength(1);
  });

  test("the copy is not a model of its own", async () => {
    stand.models = [
      { name: "bonsai-2:latest", modified_at: OLD, capabilities: CHAT, context: 262_144 },
      {
        name: "bonsai-2:latest-ruri",
        modified_at: "2026-02-01T00:00:00Z",
        capabilities: CHAT,
        parameters: "num_ctx 32768",
      },
    ];
    expect((await lookLocal()).map((m) => m.name)).toEqual(["bonsai-2:latest"]);
    expect(await sizeLocal("bonsai-2:latest")).toBe("bonsai-2:latest-ruri");
    expect(stand.created).toEqual([]);
  });

  test("a copy older than its model, or sized otherwise, is made again", async () => {
    stand.models = [
      { name: "a:latest", modified_at: "2026-03-01T00:00:00Z", capabilities: CHAT, context: 131_072 },
      { name: "a:latest-ruri", modified_at: OLD, capabilities: CHAT, parameters: "num_ctx 32768" },
      { name: "b:latest", modified_at: OLD, capabilities: CHAT, context: 131_072 },
      { name: "b:latest-ruri", modified_at: "2026-03-01T00:00:00Z", parameters: "num_ctx 8192" },
    ];
    await lookLocal();
    await sizeLocal("a:latest");
    await sizeLocal("b:latest");
    expect(stand.created.map((c) => c.model).sort()).toEqual(["a:latest-ruri", "b:latest-ruri"]);
  });

  test("a model that sets a window that large itself is served as it is", async () => {
    stand.models = [
      {
        name: "big:latest",
        modified_at: OLD,
        capabilities: CHAT,
        context: 131_072,
        parameters: "temperature 1\nnum_ctx                        65536",
      },
    ];
    const [model] = await lookLocal();
    expect(model).toMatchObject({ serve: "big:latest", window: 65_536 });
    expect(await sizeLocal("big:latest")).toBe("big:latest");
    expect(stand.created).toEqual([]);
  });

  test("the window is never more than the model was trained for, and RURI_OLLAMA_CTX sets it", async () => {
    stand.models = [
      { name: "tiny:latest", modified_at: OLD, capabilities: CHAT, context: 8_192 },
      { name: "wide:latest", modified_at: OLD, capabilities: CHAT, context: 262_144 },
    ];
    process.env["RURI_OLLAMA_CTX"] = "65536";
    const found = await lookLocal();
    expect(found.map((m) => [m.name, m.window])).toEqual([
      ["tiny:latest", 8_192],
      ["wide:latest", 65_536],
    ]);
  });

  test("a model that only embeds is not a chat model; one Ollama says nothing of is taken at its word", async () => {
    stand.models = [
      { name: "nomic-embed-text:latest", modified_at: OLD, capabilities: ["embedding"] },
      { name: "plain:latest", modified_at: OLD, capabilities: ["completion"] },
      { name: "old:latest", modified_at: OLD },
    ];
    const found = await lookLocal();
    expect(found.map((m) => [m.name, m.tools])).toEqual([
      ["plain:latest", false],
      ["old:latest", true],
    ]);
    expect(localModel("nomic-embed-text:latest")).toBeUndefined();
  });

  test("a model is asked about once while it stands unchanged", async () => {
    stand.models = [{ name: "bonsai-2:27b", modified_at: OLD, capabilities: CHAT, context: 262_144 }];
    await lookLocal();
    await lookLocal();
    expect(stand.shows).toEqual(["bonsai-2:27b"]);
  });

  test("a name the last look did not find is asked for as it is", async () => {
    await lookLocal();
    expect(servingLocal("gone:latest")).toBe("gone:latest");
    expect(stand.created).toEqual([]);
  });
});

describe("local models in the catalog", () => {
  const efforts = { reasoningEfforts: [{ value: "high" }], defaultEffort: "high" };
  const listed = (name: string): ModelChoice => ({
    value: `opencode:ollama/${name}`,
    displayName: name,
    provider: "opencode",
    providerLabel: "OpenCode",
    agentic: true,
    ...efforts,
  });
  const zen: ModelChoice = {
    value: "opencode:opencode/big-pickle",
    displayName: "Big Pickle",
    provider: "opencode",
    providerLabel: "OpenCode",
    agentic: true,
    ...efforts,
  };

  test("marked local, no reasoning level, the copies and the ones without tools gone, the rest of OpenCode's untouched", () => {
    const out = localChoices(
      [
        listed("bonsai-2:latest"),
        listed("bonsai-2:latest-ruri"),
        listed("talker:latest"),
        listed("seer:latest"),
        zen,
      ],
      [
        {
          name: "bonsai-2:latest",
          serve: "bonsai-2:latest-ruri",
          window: 32_768,
          tools: true,
          vision: false,
          thinking: true,
        },
        {
          name: "talker:latest",
          serve: "talker:latest-ruri",
          window: 32_768,
          tools: false,
          vision: false,
          thinking: false,
        },
        {
          name: "seer:latest",
          serve: "seer:latest-ruri",
          window: 32_768,
          tools: true,
          vision: true,
          thinking: false,
        },
      ],
    );
    expect(out).toEqual([
      {
        value: "opencode:ollama/bonsai-2:latest",
        displayName: "bonsai-2:latest",
        provider: "opencode",
        providerLabel: "OpenCode",
        agentic: true,
        local: "Ollama",
        inputModalities: ["text"],
      },
      {
        value: "opencode:ollama/seer:latest",
        displayName: "seer:latest",
        provider: "opencode",
        providerLabel: "OpenCode",
        agentic: true,
        local: "Ollama",
        inputModalities: ["text", "image"],
      },
      zen,
    ]);
  });

  test("with no word from Ollama they are still listed, marked local, with no reasoning level", () => {
    expect(localChoices([listed("bonsai-2:latest"), listed("bonsai-2:latest-ruri")], [])).toEqual([
      {
        value: "opencode:ollama/bonsai-2:latest",
        displayName: "bonsai-2:latest",
        provider: "opencode",
        providerLabel: "OpenCode",
        agentic: true,
        local: "Ollama",
      },
    ]);
  });
});
