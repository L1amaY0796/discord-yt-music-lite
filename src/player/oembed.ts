const OEMBED_TIMEOUT_MS = 5_000;

/** 用 YouTube 官方 oEmbed API 取標題（單純 HTTP GET，不用 spawn yt-dlp）。取不到就回傳 null。 */
export async function fetchYoutubeTitle(url: string): Promise<string | null> {
  try {
    const res = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`, {
      signal: AbortSignal.timeout(OEMBED_TIMEOUT_MS),
    });
    if (!res.ok) return null;

    const data = (await res.json()) as { title?: unknown };
    return typeof data.title === 'string' ? data.title : null;
  } catch {
    return null;
  }
}
