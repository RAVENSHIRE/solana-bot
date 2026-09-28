import { writeFileSync } from "node:fs";
import { zodToJsonSchema } from "zod-to-json-schema";
import { BotStateSchema } from "./state";
writeFileSync(
  new URL("./bot-state.schema.json", import.meta.url),
  JSON.stringify(zodToJsonSchema(BotStateSchema, "BotState"), null, 2) + "\n",
);
