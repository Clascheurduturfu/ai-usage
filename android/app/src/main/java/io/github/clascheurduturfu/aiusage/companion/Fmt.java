package io.github.clascheurduturfu.aiusage.companion;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/** Small formatting helpers shared by the dashboard and the widgets. */
public final class Fmt {

    private Fmt() {
    }

    /** "93%" / "42.5%" / "\u2014" when unknown. Values clamped to 0-100. */
    public static String pct(double v) {
        if (Double.isNaN(v)) return "\u2014";
        double clamped = Math.max(0, Math.min(100, v));
        if (clamped == Math.rint(clamped)) {
            return String.format(Locale.US, "%d%%", (long) clamped);
        }
        return String.format(Locale.US, "%.1f%%", clamped);
    }

    public static String usd(double v) {
        if (Double.isNaN(v)) return "\u2014";
        return String.format(Locale.US, "$%.2f", v);
    }

    /** Plain number without trailing ".0" (used for credits). */
    public static String num(double v) {
        if (Double.isNaN(v)) return "\u2014";
        if (v == Math.rint(v)) return String.format(Locale.US, "%d", (long) v);
        return String.format(Locale.US, "%.1f", v);
    }

    /**
     * "resets in 6d 8h" / "resets in 8h 45m" / "resets in 42m",
     * "resetting\u2026" when the reset time is in the past,
     * or null when resetAtMs <= 0 (unknown).
     */
    public static String resetsIn(long resetAtMs, long now) {
        if (resetAtMs <= 0) return null;
        long diff = resetAtMs - now;
        if (diff <= 0) return "resetting\u2026";
        long days = diff / 86_400_000L;
        long hours = (diff / 3_600_000L) % 24;
        long minutes = (diff / 60_000L) % 60;
        if (days > 0) return String.format(Locale.US, "resets in %dd %dh", days, hours);
        if (hours > 0) return String.format(Locale.US, "resets in %dh %dm", hours, minutes);
        return String.format(Locale.US, "resets in %dm", minutes);
    }

    /** Relative time like "5m ago" / "3h ago" / "2d ago" / "just now". */
    public static String relative(long timeMs, long now) {
        if (timeMs <= 0) return "never";
        long diff = now - timeMs;
        if (diff < 60_000L) return "just now";
        long minutes = diff / 60_000L;
        if (minutes < 60) return minutes + "m ago";
        long hours = minutes / 60;
        if (hours < 24) return hours + "h ago";
        long days = hours / 24;
        if (days < 7) return days + "d ago";
        return new SimpleDateFormat("MMM d", Locale.getDefault()).format(new Date(timeMs));
    }
}
