package com.langirt.lig;

import android.os.Bundle;
import android.view.View;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(KeepAwakePlugin.class);
        super.onCreate(savedInstanceState);

        // Android 15+ uygulamayı ekranın tamamına yayar (edge-to-edge). Saat/şarj çubuğu ve
        // alttaki gezinme tuşları içeriğin üstüne binmesin diye içerik bu çubukların arasına
        // yerleştirilir; çubukların arkası uygulamanın zemin rengiyle dolar. Klavye açılınca
        // alt boşluk klavye kadar olur, böylece yazılan alan klavyenin altında kalmaz.
        View content = findViewById(android.R.id.content);
        ViewCompat.setOnApplyWindowInsetsListener(content, (v, insets) -> {
            Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            Insets ime = insets.getInsets(WindowInsetsCompat.Type.ime());
            v.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, ime.bottom));
            return WindowInsetsCompat.CONSUMED;
        });

        // Koyu zemin üzerinde açık renkli simgeler
        WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        controller.setAppearanceLightStatusBars(false);
        controller.setAppearanceLightNavigationBars(false);
    }
}
