import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

export interface Env {
  AI: Fetcher;
  IMAGES: R2Bucket;
}

async function streamToUint8Array(stream: ReadableStream): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }

  const total = chunks.reduce((a, c) => a + c.length, 0);
  const merged = new Uint8Array(total);
  let offset = 0;

  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }

  return merged;
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";

  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }

  return btoa(binary);
}

async function imageUrlToBase64(imageUrl: string): Promise<string> {
  const response = await fetch(imageUrl);
  const bytes = new Uint8Array(await response.arrayBuffer());
  return uint8ArrayToBase64(bytes);
}

async function generateImage(
  env: Env,
  prompt: string,
  negative_prompt: string | undefined,
  customer_id: string,
  image_url?: string
): Promise<string> {
  const input: Record<string, unknown> = {
    prompt,
    negative_prompt,
    width: 1024,
    height: 1024,
    num_steps: 20,
    guidance: 7.5,
  };

  if (image_url) {
    input.image_b64 = await imageUrlToBase64(image_url);
    input.strength = 0.65;
  }

  const result = await env.AI.run(
    "@cf/stabilityai/stable-diffusion-xl-base-1.0",
    input
  );

  const imageBytes = await streamToUint8Array(result as ReadableStream);

  const key = `${customer_id}${Math.floor(1000 + Math.random() * 9000)}.png`;

  await env.IMAGES.put(key, imageBytes, {
    httpMetadata: { contentType: "image/png" },
  });

  return `https://imagine.tattty.com/${key}`;
}

function createServer(env: Env) {
  const server = new McpServer({
    name: "stable-diffusion-xl",
    version: "1.0.0",
  });

  server.registerTool(
    "generate-image",
    {
      description: "Generate or edit an image using Stable Diffusion XL",
      inputSchema: {
        prompt: z.string().min(1),
        negative_prompt: z.string().optional(),
        customer_id: z.string().min(1),
        image_url: z.string().url().optional(),
      },
    },
    async (params) => {
      const url = await generateImage(
        env,
        params.prompt,
        params.negative_prompt,
        params.customer_id,
        params.image_url
      );

      return {
        content: [{ type: "text", text: url }],
      };
    }
  );

  return server;
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/mcp")) {
      return createMcpHandler(() => createServer(env))(request, env, ctx);
    }

    if (url.pathname === "/generate") {
      const body = await request.json<{
        prompt: string;
        negative_prompt?: string;
        customer_id: string;
        image_url?: string;
      }>();

      const imageUrl = await generateImage(
        env,
        body.prompt,
        body.negative_prompt,
        body.customer_id,
        body.image_url
      );

      return new Response(imageUrl, {
        headers: { "content-type": "text/plain" },
      });
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
