/**
 * Opening-screen phone alerts (owner, 6 Oct): every breakout the opening screen finds goes to the phone (ntfy), coloured
 * by its speed: the multiple from the first curve read to the breakout, the dashboard's "Speed" column (×N).
 *
 * Edit this block to change the text, the tags (ntfy turns emoji shortcodes into the coloured icons) and the speed
 * bands; nothing else in the desk reads it. Restart the desk after a change (logs\redeploy-ui.mjs, or ops\supervise.mjs).
 *
 * Measured on 6 Oct (08–17 UTC): about 14 breakouts an hour, at most 26; 25 % of them in the ×2.1–2.9 band. On 3 Oct
 * about 12 an hour used up the free ntfy.sh quota (HTTP 429), and after that no alert of any kind reached the phone.
 * To keep rug alerts on held coins safe, send this feed to its own topic on another server (a self-hosted ntfy, or a
 * paid ntfy.sh account): DESK_OPENING_NTFY_TOPIC and DESK_OPENING_NTFY_SERVER in .env. ntfy.sh counts its quota per
 * IP address, so a second topic on ntfy.sh alone does not help.
 */

// ==================== OPENING SCREEN NTFY CONFIG ====================
export type NtfyPriority = 'min' | 'low' | 'default' | 'high' | 'max';
export interface OpeningAlertToken {
  name: string; ticker: string;
  /** The speed multiple as text ("2.4"), or "--" when unknown. */
  speed: string;
  /** Market caps without the $ sign ("10.2K"); the template adds it. */
  openingCandle: string; currentPrice: string; low: string; peak: string;
  /** Minutes since launch. */
  age: number;
  ca: string;
}

export const OPENING_SCREEN_ALERT_CONFIG = {
  /** false: no opening-screen alert reaches the phone (the dashboard switch "Opening screen" must be on as well). */
  enabled: true,
  /** null: every breakout is sent. A number: at most that many an hour (protects the ntfy quota). */
  maxPerHour: null as number | null,
  /**
   * Breakouts of copycats, impersonators, rugged creators and brand-name coins (owner, 5 Oct: "these are scam coins")
   * stay off the phone. true: send them too, marked with the reason.
   */
  includeBlocked: false,

  // Target sweet-spot velocity window
  targetMinVelocity: 2.1,
  targetMaxVelocity: 2.9,

  // Colour-code routing and priority tags
  getTagAndPriority(speed: number | string | null): { priority: NtfyPriority; tags: string[]; badge: string } {
    const val = typeof speed === 'number' ? speed : parseFloat(String(speed));
    if (Number.isFinite(val) && val >= this.targetMinVelocity && val <= this.targetMaxVelocity) {
      return { priority: 'high', tags: ['yellow_circle', 'dart', 'chart_with_upwards_trend'], badge: '🎯 [TARGET SWEET SPOT]' };
    } else if (Number.isFinite(val) && val > this.targetMaxVelocity) {
      return { priority: 'default', tags: ['red_circle', 'rocket'], badge: '⚡ [HIGH SPEED]' };
    } else {
      return { priority: 'low', tags: ['large_blue_circle', 'eyes'], badge: '👀 [STANDARD DETECT]' };
    }
  },

  /** The notification title (plain ASCII: ntfy headers carry no emoji; the badge is in the body). */
  formatTitle: (token: OpeningAlertToken) => `OPEN ${token.ticker} x${token.speed} at $${token.currentPrice}`,

  // Edit notification body text directly here:
  formatMessage: (token: OpeningAlertToken, badge: string) => `
${badge} ${token.name} ($${token.ticker})
• Velocity Speed: ${token.speed}
• Open: $${token.openingCandle} ➔ Now: $${token.currentPrice}
• Low: $${token.low} | Peak: $${token.peak}
• Age: ${token.age}m
• CA: \`${token.ca}\`
  `.trim(),

  /** Added under the message; '' for none. Research, 5 Oct: 59 of 65 OPEN alerts were dead or −70 % within an hour. */
  footer: 'Not a qualified call: most fast openers are dead within an hour. Tap to open in FOMO.',
};
// ===================================================================

/** Market cap as the template expects it: "10.2K", "1.25M", "--". */
export const capText = (usd: number | null | undefined): string =>
  usd == null || !Number.isFinite(usd) ? '--' : usd >= 1e6 ? `${(usd / 1e6).toFixed(2)}M` : `${(usd / 1e3).toFixed(1)}K`;
