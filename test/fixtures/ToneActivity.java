package dev.agentmobile.tone;

import android.app.Activity;
import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioTrack;
import android.os.Bundle;
import android.widget.TextView;

/** Offline, test-only source of a known continuous 440 Hz media signal. */
public final class ToneActivity extends Activity {
    private AudioTrack track;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        TextView label = new TextView(this);
        label.setText("Agent Mobile Runtime\n440 Hz internal audio acceptance fixture");
        label.setTextSize(24);
        setContentView(label);
        AudioManager manager = (AudioManager) getSystemService(AUDIO_SERVICE);
        manager.setStreamVolume(AudioManager.STREAM_MUSIC,
                manager.getStreamMaxVolume(AudioManager.STREAM_MUSIC), 0);
        int sampleRate = 16000;
        short[] samples = new short[sampleRate * 2];
        for (int i = 0; i < samples.length; i++) {
            samples[i] = (short) (8192 * Math.sin(2 * Math.PI * 440 * i / sampleRate));
        }
        track = new AudioTrack.Builder()
                .setAudioAttributes(new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_MEDIA)
                        .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build())
                .setAudioFormat(new AudioFormat.Builder().setSampleRate(sampleRate)
                        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                        .setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
                .setTransferMode(AudioTrack.MODE_STATIC)
                .setBufferSizeInBytes(samples.length * 2).build();
        track.write(samples, 0, samples.length);
        track.setLoopPoints(0, samples.length, -1);
        track.play();
    }

    @Override public void onDestroy() {
        if (track != null) { track.stop(); track.release(); track = null; }
        super.onDestroy();
    }
}
