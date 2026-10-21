package io.github.clascheurduturfu.aiusage.companion;

import android.content.Context;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.MalformedURLException;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * Fetches the latest AI Usage snapshot from ntfy.
 *
 * Contract: GET {server}/{topic}/json?poll=1 returns newline-delimited JSON
 * envelopes, one per cached message, each like
 * {"id":"...","time":1699999999,"message":"<snapshot json>","title":"..."}.
 * The LAST message whose payload parses as a v1 snapshot wins.
 * Optional auth: "Authorization: Bearer <token>" when a token is configured.
 *
 * MUST be called from a background thread.
 */
public final class NtfyFetcher {

    private static final int CONNECT_TIMEOUT_MS = 10_000;
    private static final int READ_TIMEOUT_MS = 15_000;

    private NtfyFetcher() {
    }

    /** @throws IOException with a user-readable message on any failure. */
    public static Model.Snapshot fetch(Context c) throws IOException {
        String server = SettingsPrefs.server(c).trim();
        String topic = SettingsPrefs.topic(c).trim();
        String token = SettingsPrefs.token(c).trim();

        if (server.isEmpty() || topic.isEmpty()) {
            throw new IOException("ntfy server or topic is not configured");
        }
        if (!server.startsWith("http://") && !server.startsWith("https://")) {
            throw new IOException("Server URL must start with http:// or https://");
        }
        String url = server + "/" + topic + "/json?poll=1";

        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setRequestMethod("GET");
            conn.setConnectTimeout(CONNECT_TIMEOUT_MS);
            conn.setReadTimeout(READ_TIMEOUT_MS);
            if (!token.isEmpty()) {
                conn.setRequestProperty("Authorization", "Bearer " + token);
            }
            int code = conn.getResponseCode();
            if (code == HttpURLConnection.HTTP_UNAUTHORIZED || code == HttpURLConnection.HTTP_FORBIDDEN) {
                throw new IOException("Unauthorized (HTTP " + code + ") - check the access token");
            }
            if (code == HttpURLConnection.HTTP_NOT_FOUND) {
                throw new IOException("Not found (HTTP 404) - check the server URL and topic");
            }
            if (code >= 400) {
                throw new IOException("Server error (HTTP " + code + ")");
            }
            String body = readAll(conn.getInputStream());
            return latestSnapshot(body);
        } catch (MalformedURLException e) {
            throw new IOException("Invalid ntfy server URL");
        } catch (SocketTimeoutException e) {
            throw new IOException("Connection timed out");
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private static String readAll(InputStream in) throws IOException {
        StringBuilder sb = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(
                new InputStreamReader(in, StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                sb.append(line).append('\n');
            }
        }
        return sb.toString();
    }

    /** Picks the LAST line whose payload is a valid v1 snapshot. */
    static Model.Snapshot latestSnapshot(String ndjsonBody) throws IOException {
        if (ndjsonBody == null || ndjsonBody.trim().isEmpty()) {
            throw new IOException("The topic has no cached messages yet");
        }
        Model.Snapshot latest = null;
        String[] lines = ndjsonBody.split("\n");
        for (String line : lines) {
            String trimmed = line.trim();
            if (trimmed.isEmpty()) continue;
            JSONObject envelope;
            try {
                envelope = new JSONObject(trimmed);
            } catch (JSONException ignored) {
                continue; // not a JSON line (keepalive, banner, ...)
            }
            String payload = envelope.optString("message", null);
            if (payload == null) payload = trimmed; // defensive: the line itself may be the snapshot
            try {
                Model.Snapshot s = SnapshotParser.parse(payload);
                long envTimeMs = envelope.optLong("time", 0L) * 1000L;
                if (s.updatedAt <= 0L && envTimeMs > 0L) s.updatedAt = envTimeMs;
                latest = s;
            } catch (JSONException ignored) {
                // not a v1 snapshot message; skip
            }
        }
        if (latest == null) {
            throw new IOException("No AI Usage snapshot found on this topic yet");
        }
        return latest;
    }
}
