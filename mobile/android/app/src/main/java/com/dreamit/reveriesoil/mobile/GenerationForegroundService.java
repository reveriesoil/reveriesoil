package com.dreamit.reveriesoil.mobile;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import androidx.core.app.NotificationCompat;

/**
 * GenerationForegroundService
 * 生成故事时保持应用在后台持续运行（前台服务），防止 Android 暂停 JS 执行。
 */
public class GenerationForegroundService extends Service {

    static final String CHANNEL_ID = "rs_generation_channel";
    static final int    NOTIF_ID   = 9001;

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        startForeground(NOTIF_ID, buildNotification());
        return START_NOT_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    // ── 通知频道（Android 8+） ────────────────────────────────────────────────
    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel ch = new NotificationChannel(
                CHANNEL_ID,
                "故事生成",
                NotificationManager.IMPORTANCE_LOW
            );
            ch.setDescription("ReverieSoil 正在后台生成故事，请勿关闭应用");
            ch.setSound(null, null);
            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm != null) nm.createNotificationChannel(ch);
        }
    }

    // ── 前台通知 ─────────────────────────────────────────────────────────────
    private Notification buildNotification() {
        Intent launchIntent = new Intent(this, MainActivity.class);
        launchIntent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);

        int piFlags = Build.VERSION.SDK_INT >= Build.VERSION_CODES.M
            ? PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
            : PendingIntent.FLAG_UPDATE_CURRENT;

        PendingIntent pi = PendingIntent.getActivity(this, 0, launchIntent, piFlags);

        return new NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("ReverieSoil 梦壤")
            .setContentText("故事正在生成中，请稍候…")
            .setSmallIcon(android.R.drawable.ic_popup_sync)
            .setContentIntent(pi)
            .setOngoing(true)
            .setCategory(NotificationCompat.CATEGORY_PROGRESS)
            .build();
    }
}
