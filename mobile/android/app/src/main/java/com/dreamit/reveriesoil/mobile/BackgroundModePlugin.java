package com.dreamit.reveriesoil.mobile;

import android.content.Intent;
import android.os.Build;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * BackgroundModePlugin — Capacitor 插件
 * 提供 enable()/disable() 方法，JS 层调用来启停前台服务，
 * 确保生成任务期间 Android 不会暂停 WebView JS 执行。
 */
@CapacitorPlugin(name = "BackgroundMode")
public class BackgroundModePlugin extends Plugin {

    @PluginMethod
    public void enable(PluginCall call) {
        Intent intent = new Intent(getContext(), GenerationForegroundService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            getContext().startForegroundService(intent);
        } else {
            getContext().startService(intent);
        }
        call.resolve();
    }

    @PluginMethod
    public void disable(PluginCall call) {
        Intent intent = new Intent(getContext(), GenerationForegroundService.class);
        getContext().stopService(intent);
        call.resolve();
    }
}
