import { createMcpHandler } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

interface Env {
  AI: Ai;
}

const mcpServer = new McpServer({
  name: "tattty-sdxl",
  version: "1.0.0",
});

mcpServer.tool(
  "generate-image",
  "Generate a PNG image from a text prompt using Stable Diffusion XL.",
  {
    prompt: z
      .string()
      .min(1)
      .max(2_000)
      .describe("The image to generate"),

    negative_prompt: z
      .string()
      .max(2_000)
      .optional()
      .describe("Things to avoid in the generated image"),

    width: z
      .number()
      .int()
      .min(256)
      .max(2048)
      .default(1024)
      .describe("Image width in pixels"),

    height: z
      .number()
      .int()
      .min(256)
      .max(2048)
      .default(1024)
      .describe("Image height in pixels"),

    num_steps: z
      .number()
      .int()
      .min(1)
      .max(20)
      .default(20)
      .describe("Number of diffusion steps"),

    guidance: z
      .number()
      .min(1)
      .max(20)
      .default(7.5)
      .describe("Prompt guidance scale"),

    seed: z
      .number()
      .int()
      .optional()
      .describe("Optional fixed seed for reproducibility"),
  },

  async (params, extra) => {
    const env = extra.env as Env;

    try {
      const result = await env.AI.run(
        "@cf/stabilityai/stable-diffusion-xl-base-1.0",
        {
          prompt: params.prompt,
          negative_prompt: params.negative_prompt ?? "blurry, low quality",
          width: params.width,
          height: params.height,
          num_steps: params.num_steps,
          guidance: params.guidance,
          seed: params.seed,
        }
      );

      const bytes = new Uint8Array(
        await new Response(result as ReadableStream).arrayBuffer()
      );

      // Avoid String.fromCharCode(...bytes), which can exceed the
      // JavaScript argument limit for a full-size generated PNG.
      let binary = "";
      const chunkSize = 32_768;

      for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(
          ...bytes.subarray(i, i + chunkSize)
        );
      }

      return {
        content: [
          {
            type: "image",
            data: btoa(binary),
            mimeType: "image/png",
          },
        ],
      };
    } catch (error) {
      console.error("SDXL generation failed", error);

      return {
        content: [
          {
            type: "text",
            text: error instanceof Error
              ? `Image generation failed: ${error.message}`
              : "Image generation failed",
          },
        ],
        isError: true,
      };
    }
  }
);

// This is the actual MCP server handler.
// It handles initialize, notifications/initialized, tools/list, and tools/call.
const mcpHandler = createMcpHandler(mcpServer);

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

    // MCP endpoint:
    // https://sdxl.tattty.com/mcp
    if (url.pathname === "/mcp") {
      return mcpHandler(request, env, ctx);
    }

    // Optional direct non-MCP endpoint for your TaTTTy UI.
    // GET /generate?prompt=blackwork+dragon+tattoo
    if (url.pathname === "/generate") {
      const prompt = url.searchParams.get("prompt");

      if (!prompt) {
        return Response.json(
          { error: "Missing required ?prompt= parameter" },
          { status: 400 }
        );
      }

      const result = await env.AI.run(
        "@cf/stabilityai/stable-diffusion-xl-base-1.0",
        {
          prompt,
          negative_prompt:
            url.searchParams.get("negative_prompt") ??
            "blurry, low quality",
          width: 1024,
          height: 1024,
          num_steps: 20,
          guidance: 7.5,
        }
      );

      return new Response(result as ReadableStream, {
        headers: {
          "content-type": "image/png",
          "cache-control": "no-store",
        },
      });
    }

    return Response.json({
      name: "TaTTTy SDXL MCP Server",
      mcpEndpoint: "https://sdxl.tattty.com/mcp",
      directImageEndpoint:
        "https://sdxl.tattty.com/generate?prompt=YOUR_PROMPT",
    });
  },
};