// Generate embeddings via OpenRouter (OpenAI-compatible endpoint)
// Uses text-embedding-3-small (1536 dimensions)

const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY");

if (!OPENROUTER_API_KEY) {
  throw new Error("Missing OPENROUTER_API_KEY in environment");
}

const EMBEDDING_MODEL = "openai/text-embedding-3-small";
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Generate a 1536-dimensional embedding for a single text string.
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch("https://openrouter.ai/api/v1/embeddings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${OPENROUTER_API_KEY}`,
          "HTTP-Referer": "https://gadaa.ai",
          "X-Title": "Agora Corpus Ingestion",
        },
        body: JSON.stringify({
          model: EMBEDDING_MODEL,
          input: text,
        }),
      });

      if (res.status === 429) {
        const wait = RETRY_DELAY_MS * attempt;
        console.warn(`Rate limited, waiting ${wait}ms (attempt ${attempt}/${MAX_RETRIES})`);
        await sleep(wait);
        continue;
      }

      if (!res.ok) {
        const body = await res.text().catch(() => "unknown");
        throw new Error(`OpenRouter embedding error ${res.status}: ${body}`);
      }

      const data = await res.json();
      const embedding = data.data?.[0]?.embedding;
      if (!embedding || !Array.isArray(embedding)) {
        throw new Error("Invalid embedding response shape");
      }
      return embedding;
    } catch (err) {
      if (attempt === MAX_RETRIES) throw err;
      console.warn(`Embedding attempt ${attempt} failed, retrying...`);
      await sleep(RETRY_DELAY_MS * attempt);
    }
  }
  throw new Error("Exhausted retries");
}

/**
 * Generate embeddings for multiple texts with rate limiting.
 * Processes sequentially to avoid overwhelming the API.
 */
export async function generateEmbeddings(
  texts: string[]
): Promise<number[][]> {
  const embeddings: number[][] = [];
  for (let i = 0; i < texts.length; i++) {
    embeddings.push(await generateEmbedding(texts[i]));
    // Small delay between requests to avoid rate limits
    if (i < texts.length - 1) await sleep(200);
  }
  return embeddings;
}
