package io.github.rayhe.tvwand;

import android.Manifest;
import android.app.Activity;
import android.bluetooth.BluetoothAdapter;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * Hosts the 3D scene (a WebView running assets/www) and bridges it to the
 * native Bluetooth stack, since Android WebView has no Web Bluetooth.
 *
 * Native -> page: batched events delivered to window.tvwand.onNative([...]).
 * Page -> native: the TvWandNative JavaScript interface.
 */
public final class MainActivity extends Activity implements WandManager.Listener {
    /** Served from assets/www. A real https origin keeps ES modules and localStorage working. */
    private static final String ORIGIN_HOST = "appassets.androidplatform.net";
    /**
     * http, not https: Chromium blocks ws:// from an https page as mixed content
     * even with setMixedContentMode, which would break the wand relay.
     */
    private static final String START_URL = "http://" + ORIGIN_HOST + "/index.html";
    private static final int REQ_PERMISSIONS = 1;
    private static final int REQ_ENABLE_BT = 2;
    private static final long FLUSH_MS = 16;

    private WebView web;
    private WandManager wands;
    private boolean pageReady;
    private boolean permitted;
    private String relay; // ws://host:port when wands come from a relay host
    private boolean showTelemetry;
    private String extraQuery; // raw extra query parameters, e.g. demowands=10

    // Events are batched to one evaluateJavascript call per frame: IMU packets
    // from several wands would otherwise flood the UI thread.
    private final List<JSONObject> pending = new ArrayList<>();
    private boolean flushScheduled;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        WebView.setWebContentsDebuggingEnabled(true); // chrome://inspect over adb
        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        // A relay is plain ws:// on the LAN while the page is https://, which Chromium
        // would otherwise block as mixed content.
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        web.setBackgroundColor(0xFF0B0820);
        web.setFocusable(true);
        web.setWebViewClient(new AssetClient());
        web.setWebChromeClient(new android.webkit.WebChromeClient() {
            @Override
            public boolean onConsoleMessage(android.webkit.ConsoleMessage m) {
                Log.i("WandConsole", m.message() + " @" + m.sourceId() + ":" + m.lineNumber());
                return true;
            }
        });
        web.addJavascriptInterface(new Bridge(), "TvWandNative");
        setContentView(web);
        hideSystemUi();

        wands = new WandManager(this, this);
        applyFlags(getIntent());
        applyWandExtras(getIntent());
        web.loadUrl(startUrl());
        requestBluetoothPermissions();
    }

    /** The scene, plus ?relay=... when wands arrive over the network instead. */
    private String startUrl() {
        StringBuilder url = new StringBuilder(START_URL);
        char sep = '?';
        if (relay != null && !relay.isEmpty()) {
            url.append(sep).append("relay=").append(Uri.encode(relay));
            sep = '&';
        }
        if (showTelemetry) {
            url.append(sep).append("telemetry=1");
            sep = '&';
        }
        if (extraQuery != null && !extraQuery.isEmpty()) url.append(sep).append(extraQuery);
        return url.toString();
    }

    private void applyFlags(Intent intent) {
        if (intent == null) return;
        String extra = intent.getStringExtra("relay");
        if (extra != null) {
            relay = extra.trim().isEmpty() ? null : extra.trim();
            getSharedPreferences("wandcircle", MODE_PRIVATE).edit()
                    .putString("relay", relay == null ? "" : relay).apply();
        } else {
            String saved = getSharedPreferences("wandcircle", MODE_PRIVATE).getString("relay", "");
            relay = saved == null || saved.isEmpty() ? null : saved;
        }
        if (intent.hasExtra("telemetry")) {
            showTelemetry = intent.getBooleanExtra("telemetry", false);
        }
        String query = intent.getStringExtra("query");
        if (query != null) extraQuery = query.trim();
    }

    /** Wands can be handed to the app on launch: adb shell am start ... --es wand AA:BB:.. */
    private void applyWandExtras(Intent intent) {
        if (intent == null) return;
        String single = intent.getStringExtra("wand");
        if (single != null) {
            for (String mac : single.split("[,;\\s]+")) wands.addKnown(mac);
        }
        String many = intent.getStringExtra("wands");
        if (many != null) {
            for (String mac : many.split("[,;\\s]+")) wands.addKnown(mac);
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        String before = relay;
        boolean telemetryBefore = showTelemetry;
        applyFlags(intent);
        applyWandExtras(intent);
        if (!java.util.Objects.equals(before, relay) || telemetryBefore != showTelemetry) web.loadUrl(startUrl());
    }

    private void hideSystemUi() {
        web.setSystemUiVisibility(View.SYSTEM_UI_FLAG_FULLSCREEN
                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
    }

    // ---------- Permissions and Bluetooth state ----------

    private String[] neededPermissions() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            return new String[] {Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT};
        }
        return new String[] {Manifest.permission.ACCESS_FINE_LOCATION};
    }

    private void requestBluetoothPermissions() {
        if (relay != null) return; // the relay host does the Bluetooth work
        List<String> missing = new ArrayList<>();
        for (String p : neededPermissions()) {
            if (checkSelfPermission(p) != PackageManager.PERMISSION_GRANTED) missing.add(p);
        }
        if (missing.isEmpty()) {
            permitted = true;
            maybeStart();
        } else {
            requestPermissions(missing.toArray(new String[0]), REQ_PERMISSIONS);
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        if (requestCode != REQ_PERMISSIONS) return;
        boolean ok = results.length > 0;
        for (int r : results) ok &= r == PackageManager.PERMISSION_GRANTED;
        permitted = ok;
        if (ok) maybeStart();
        else onStatus("permission", "Bluetooth permission was denied. Allow it in Settings > Apps > Wand Circle.");
    }

    @SuppressWarnings("MissingPermission")
    private void maybeStart() {
        if (relay != null) return; // wands come over the network, not this radio
        if (!pageReady || !permitted) return;
        if (!wands.bluetoothAvailable()) {
            onStatus("no-bluetooth", "This device has no Bluetooth LE adapter.");
            return;
        }
        if (!wands.bluetoothEnabled()) {
            onStatus("bluetooth-off", "Bluetooth is off. Turn it on to find wands.");
            try {
                startActivityForResult(new Intent(BluetoothAdapter.ACTION_REQUEST_ENABLE), REQ_ENABLE_BT);
            } catch (RuntimeException ignored) {
                // Some TVs have no handler for this; the status message stands.
            }
        }
        wands.start(); // also waits for the adapter to come on
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_ENABLE_BT) maybeStart();
    }

    @Override
    protected void onResume() {
        super.onResume();
        hideSystemUi();
        if (permitted && pageReady) wands.start();
    }

    @Override
    protected void onStop() {
        super.onStop();
        // Let the wands go when the app is backgrounded, so a phone app can have them.
        wands.stop();
    }

    @Override
    protected void onDestroy() {
        wands.stop();
        web.destroy();
        super.onDestroy();
    }

    // ---------- Remote control ----------

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        String key = keyName(event.getKeyCode());
        if (key != null) {
            if (event.getAction() == KeyEvent.ACTION_DOWN && event.getRepeatCount() == 0) {
                JSONObject ev = event("key");
                put(ev, "key", key);
                post(ev);
            }
            return true;
        }
        return super.dispatchKeyEvent(event);
    }

    private static String keyName(int code) {
        switch (code) {
            case KeyEvent.KEYCODE_DPAD_CENTER:
            case KeyEvent.KEYCODE_ENTER:
            case KeyEvent.KEYCODE_NUMPAD_ENTER:
                return "center";
            case KeyEvent.KEYCODE_DPAD_UP: return "up";
            case KeyEvent.KEYCODE_DPAD_DOWN: return "down";
            case KeyEvent.KEYCODE_DPAD_LEFT: return "left";
            case KeyEvent.KEYCODE_DPAD_RIGHT: return "right";
            case KeyEvent.KEYCODE_MENU:
            case KeyEvent.KEYCODE_INFO:
                return "menu";
            default: return null;
        }
    }

    // ---------- WandManager.Listener: everything arrives on the main thread ----------

    @Override
    public void onStatus(String code, String text) {
        JSONObject ev = event("status");
        put(ev, "code", code);
        put(ev, "text", text);
        post(ev);
    }

    @Override
    public void onFound(String id, String name) {
        JSONObject ev = event("found");
        put(ev, "id", id);
        put(ev, "name", name);
        post(ev);
    }

    @Override
    public void onConnected(String id, String name) {
        JSONObject ev = event("connected");
        put(ev, "id", id);
        put(ev, "name", name);
        post(ev);
    }

    @Override
    public void onDisconnected(String id) {
        JSONObject ev = event("disconnected");
        put(ev, "id", id);
        post(ev);
    }

    @Override
    public void onNotify(String id, byte[] value) {
        JSONObject ev = event("notify");
        put(ev, "id", id);
        put(ev, "hex", Hex.encode(value));
        post(ev);
    }

    @Override
    public void onBattery(String id, int level) {
        JSONObject ev = event("battery");
        put(ev, "id", id);
        put(ev, "level", level);
        post(ev);
    }

    private static JSONObject event(String type) {
        JSONObject ev = new JSONObject();
        put(ev, "type", type);
        return ev;
    }

    private static void put(JSONObject o, String k, Object v) {
        try {
            o.put(k, v);
        } catch (JSONException e) {
            throw new IllegalArgumentException(e);
        }
    }

    private void post(JSONObject ev) {
        // While the page (re)loads, keep connection events but drop motion.
        if (!pageReady && pending.size() > 64 && "notify".equals(ev.optString("type"))) return;
        pending.add(ev);
        if (flushScheduled || !pageReady) return;
        flushScheduled = true;
        web.postDelayed(this::flush, FLUSH_MS);
    }

    private void flush() {
        flushScheduled = false;
        if (pending.isEmpty()) return;
        JSONArray batch = new JSONArray(pending);
        pending.clear();
        web.evaluateJavascript("window.tvwand&&window.tvwand.onNative(" + batch + ")", null);
    }

    // ---------- Page -> native ----------

    private final class Bridge {
        @JavascriptInterface
        public void ready() {
            runOnUiThread(() -> {
                pageReady = true;
                wands.replay(); // wands already connected before a page reload
                flush();
                maybeStart();
            });
        }

        @JavascriptInterface
        public void write(String id, String hex) {
            byte[] bytes = Hex.decode(hex);
            runOnUiThread(() -> wands.write(id, bytes));
        }

        @JavascriptInterface
        public void disconnect(String id) {
            runOnUiThread(() -> wands.disconnect(id));
        }

        @JavascriptInterface
        public String version() {
            return BuildConfig.VERSION_NAME;
        }
    }

    // ---------- assets/www served over a fake https origin ----------

    private final class AssetClient extends WebViewClient {
        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            Uri url = request.getUrl();
            if (!ORIGIN_HOST.equals(url.getHost())) return null;
            String path = url.getPath();
            if (path == null || path.equals("/")) path = "/index.html";
            String mime = mimeOf(path);
            try {
                InputStream in = getAssets().open("www" + path);
                WebResourceResponse r = new WebResourceResponse(mime, "utf-8", in);
                r.setResponseHeaders(Collections.singletonMap("Cache-Control", "no-cache"));
                return r;
            } catch (IOException e) {
                return new WebResourceResponse(mime, "utf-8", 404, "Not Found",
                        Collections.emptyMap(), null);
            }
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            return !ORIGIN_HOST.equals(request.getUrl().getHost());
        }

        @Override
        public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
            pageReady = false;
        }
    }

    private static String mimeOf(String path) {
        int dot = path.lastIndexOf('.');
        String ext = dot < 0 ? "" : path.substring(dot + 1);
        switch (ext) {
            case "html": return "text/html";
            case "js":
            case "mjs": return "text/javascript";
            case "css": return "text/css";
            case "json": return "application/json";
            case "png": return "image/png";
            case "svg": return "image/svg+xml";
            case "woff2": return "font/woff2";
            case "txt": return "text/plain";
            default: return "application/octet-stream";
        }
    }
}
