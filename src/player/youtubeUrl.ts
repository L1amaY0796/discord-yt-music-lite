const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com']);
const SHORT_HOST = 'youtu.be';
const VIDEO_ID_PATTERN = /^[\w-]{11}$/;
// /shorts/<id>、/live/<id>、/embed/<id>
const PATH_ID_PATTERN = /^\/(?:shorts|live|embed)\/([^/]+)/;

export type ParsedYoutubeUrl =
  | { ok: true; videoId: string; url: string }
  | { ok: false; reason: 'invalid' | 'not-youtube' | 'not-a-video' };

/**
 * 驗證使用者輸入是「單一 YouTube 影片」的網址，並正規化成 https://www.youtube.com/watch?v=<id>。
 *
 * 只放行 YouTube 網域：yt-dlp 的 generic extractor 會去抓任何 http(s) 網址，bot 又跑在
 * hostNetwork 上，不擋的話等於任何能下指令的人都能讓它去打內網。
 * 只放行帶影片 ID 的網址：純播放清單 / 頻道網址會讓 yt-dlp 展開整份清單（--no-playlist 擋不住）。
 * 正規化時順便丟掉 list= 等多餘參數。
 */
export function parseYoutubeUrl(input: string): ParsedYoutubeUrl {
  let parsed: URL;
  try {
    parsed = new URL(input.trim());
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, reason: 'invalid' };
  }

  const host = parsed.hostname.toLowerCase();
  let videoId: string | null | undefined;
  if (host === SHORT_HOST) {
    videoId = parsed.pathname.split('/')[1];
  } else if (YOUTUBE_HOSTS.has(host)) {
    videoId = parsed.pathname === '/watch' ? parsed.searchParams.get('v') : PATH_ID_PATTERN.exec(parsed.pathname)?.[1];
  } else {
    return { ok: false, reason: 'not-youtube' };
  }

  if (!videoId || !VIDEO_ID_PATTERN.test(videoId)) {
    return { ok: false, reason: 'not-a-video' };
  }
  return { ok: true, videoId, url: `https://www.youtube.com/watch?v=${videoId}` };
}
