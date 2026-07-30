export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Get prompt from query string, e.g. /?prompt=a+cat+in+space
    const prompt = url.searchParams.get("prompt") ?? "a cat in space, digital art";

    const result = await env.AI.run(
      "@cf/stabilityai/stable-diffusion-xl-base-1.0",
      {
        prompt,
        negative_prompt: "blurry, low quality",
        width: 1024,
        height: 1024,
        num_steps: 20,
        guidance: 7.5,
      }
    );

    // result is a ReadableStream of PNG image bytes
    return new Response(result, {
      headers: { "content-type": "image/png" },
    });
  },
};
