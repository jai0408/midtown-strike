package com.midtownstrike.game;

import android.app.Activity;
import android.graphics.Color;
import android.os.Bundle;
import android.util.Log;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * Full-screen landscape host for the game. The whole game (engine, map
 * generator, assets) is a single self-contained HTML bundle in
 * assets/game/index.html, rendered with WebGL inside the system WebView.
 *
 * Only APIs present since Android 4.1 are referenced directly; the handful
 * of newer calls go through reflection or raw constants so this file builds
 * both with Gradle and with the SDK-less pipeline in ../build_apk.py.
 */
public class MainActivity extends Activity {
    private static final String TAG = "MidtownStrike";
    private static final String START_URL = "file:///android_asset/game/index.html";

    // View.SYSTEM_UI_FLAG_* (API 19) written out as constants.
    private static final int UI_IMMERSIVE =
            0x00000100   // LAYOUT_STABLE
          | 0x00000200   // LAYOUT_HIDE_NAVIGATION
          | 0x00000400   // LAYOUT_FULLSCREEN
          | 0x00000002   // HIDE_NAVIGATION
          | 0x00000004   // FULLSCREEN
          | 0x00001000;  // IMMERSIVE_STICKY

    private WebView web;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        requestWindowFeature(Window.FEATURE_NO_TITLE);

        Window win = getWindow();
        win.addFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN
                | WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
                | WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED);

        // Draw under the camera cutout (API 28+): LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES = 1.
        try {
            WindowManager.LayoutParams lp = win.getAttributes();
            lp.getClass().getField("layoutInDisplayCutoutMode").setInt(lp, 1);
            win.setAttributes(lp);
        } catch (Throwable ignored) {
            // Older Android: no cutout support, nothing to do.
        }

        web = new WebView(this);
        web.setBackgroundColor(Color.BLACK);
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        web.setVerticalScrollBarEnabled(false);
        web.setHorizontalScrollBarEnabled(false);
        web.setHapticFeedbackEnabled(false);
        web.setLongClickable(false);
        web.setOnLongClickListener(new View.OnLongClickListener() {
            @Override
            public boolean onLongClick(View v) {
                return true; // swallow: no text-selection popups over the game
            }
        });

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setTextZoom(100);
        // API 17+: let the game start its audio without an extra tap.
        try {
            WebSettings.class.getMethod("setMediaPlaybackRequiresUserGesture", boolean.class)
                    .invoke(s, Boolean.FALSE);
        } catch (Throwable ignored) {
            // Audio then starts on the first touch instead.
        }

        web.setWebViewClient(new WebViewClient());
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage m) {
                Log.d(TAG, m.message() + " @" + m.lineNumber());
                return true;
            }
        });
        web.addJavascriptInterface(new HostBridge(), "AndroidHost");

        setContentView(web);
        applyImmersive();
        web.loadUrl(START_URL);
    }

    private void applyImmersive() {
        getWindow().getDecorView().setSystemUiVisibility(UI_IMMERSIVE);
    }

    private void callJs(String fn) {
        if (web != null) {
            web.loadUrl("javascript:void(window." + fn + "&&window." + fn + "())");
        }
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) {
            applyImmersive();
        }
    }

    @Override
    protected void onPause() {
        callJs("onHostPause");
        if (web != null) {
            web.onPause();
        }
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) {
            web.onResume();
        }
        applyImmersive();
        callJs("onHostResume");
    }

    @Override
    public void onBackPressed() {
        // The game decides: close a menu, pause the match, or ask the host to exit.
        callJs("onHostBack");
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.stopLoading();
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }

    /** Methods callable from the page as window.AndroidHost.*. */
    private final class HostBridge {
        @JavascriptInterface
        public void exit() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    finish();
                }
            });
        }

        @JavascriptInterface
        public String platform() {
            return "android";
        }
    }
}
