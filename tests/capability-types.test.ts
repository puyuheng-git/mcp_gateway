import { expect, it } from "vitest";
import { z } from "zod";
import { defineTool } from "../src/capabilities/types.js";

it("validates tool input before executing a side effect", async () => {
  let executions = 0;
  const tool = defineTool({
    name: "test.write",
    description: "Test write",
    inputSchema: z.object({ title: z.string().min(1) }).strict(),
    capabilityLevel: "L1",
    requiredScopes: ["test:write"],
    execute: async ({ title }) => {
      executions += 1;
      return { title };
    },
  });
  await expect(
    tool.execute({ title: "", injected: true }, new AbortController().signal),
  ).rejects.toThrow();
  expect(executions).toBe(0);
  await expect(tool.execute({ title: "valid" }, new AbortController().signal)).resolves.toEqual({
    title: "valid",
  });
  expect(executions).toBe(1);
});
