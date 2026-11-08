package io.github.rayhe.tvwand;

import android.annotation.SuppressLint;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCallback;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattDescriptor;
import android.bluetooth.BluetoothGattService;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothProfile;
import android.bluetooth.BluetoothStatusCodes;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanRecord;
import android.bluetooth.le.ScanResult;
import android.bluetooth.le.ScanSettings;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelUuid;
import android.os.SystemClock;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Finds every Magic Caster Wand in range and keeps it connected.
 *
 * Scanning never stops while the app is in front, so a wand that wakes up
 * (or comes back after sleeping) is picked up within a second or two.
 * Connections are opened one at a time, because most Bluetooth stacks fail
 * concurrent connectGatt() calls. Each wand has its own operation queue,
 * because Android allows only one outstanding GATT operation per connection.
 *
 * All state lives on the main thread; GATT callbacks hop onto it.
 */
@SuppressLint("MissingPermission") // MainActivity holds the permissions before start()
final class WandManager {
    interface Listener {
        void onStatus(String code, String text);
        void onFound(String id, String name);
        void onConnected(String id, String name);
        void onDisconnected(String id);
        void onNotify(String id, byte[] value);
        void onBattery(String id, int level);
    }

    static final UUID SERVICE = UUID.fromString("57420001-587e-48a0-974c-544d6163c577");
    static final UUID COMMAND = UUID.fromString("57420002-587e-48a0-974c-544d6163c577");
    static final UUID NOTIFY = UUID.fromString("57420003-587e-48a0-974c-544d6163c577");
    static final UUID BATTERY_SERVICE = UUID.fromString("0000180f-0000-1000-8000-00805f9b34fb");
    static final UUID BATTERY_LEVEL = UUID.fromString("00002a19-0000-1000-8000-00805f9b34fb");
    static final UUID CCCD = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb");
    static final String NAME_PREFIX = "MCW-";

    private static final int MAX_WANDS = 7; // a typical controller's LE connection limit
    private static final int MTU = 517; // IMU packets are longer than the default 23-byte MTU allows
    private static final long CONNECT_TIMEOUT_MS = 15_000;
    private static final long OP_TIMEOUT_MS = 3_000;
    private static final long RETRY_COOLDOWN_MS = 3_000;
    // Android demotes scans running past 30 minutes; restarting well before that keeps them live.
    private static final long SCAN_RESTART_MS = 10 * 60_000;
    private static final long SCAN_RETRY_MS = 5_000;

    private final Context ctx;
    private final Listener listener;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final BluetoothAdapter adapter;

    private final Map<String, Wand> wands = new LinkedHashMap<>();
    private final ArrayDeque<Wand> connectQueue = new ArrayDeque<>();
    private final Map<String, Long> retryAfter = new HashMap<>();
    private Wand connecting;
    private boolean running;
    private boolean scanning;
    private boolean receiverRegistered;

    WandManager(Context ctx, Listener listener) {
        this.ctx = ctx.getApplicationContext();
        this.listener = listener;
        BluetoothManager bm = ctx.getSystemService(BluetoothManager.class);
        this.adapter = bm == null ? null : bm.getAdapter();
    }

    boolean bluetoothAvailable() {
        return adapter != null && ctx.getPackageManager().hasSystemFeature(PackageManager.FEATURE_BLUETOOTH_LE);
    }

    boolean bluetoothEnabled() {
        return adapter != null && adapter.isEnabled();
    }

    void start() {
        if (running || adapter == null) return;
        running = true;
        IntentFilter f = new IntentFilter(BluetoothAdapter.ACTION_STATE_CHANGED);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            ctx.registerReceiver(stateReceiver, f, Context.RECEIVER_NOT_EXPORTED);
        } else {
            ctx.registerReceiver(stateReceiver, f);
        }
        receiverRegistered = true;
        if (adapter.isEnabled()) startScan();
    }

    void stop() {
        if (!running) return;
        running = false;
        if (receiverRegistered) {
            ctx.unregisterReceiver(stateReceiver);
            receiverRegistered = false;
        }
        stopScan();
        dropAll();
        main.removeCallbacksAndMessages(null);
    }

    /** Re-announce connected wands, for a page that just (re)loaded. */
    void replay() {
        for (Wand w : wands.values()) if (w.ready) listener.onConnected(w.id, w.name);
    }

    void write(String id, byte[] bytes) {
        Wand w = wands.get(id);
        if (w != null && w.ready) w.enqueueWrite(bytes);
    }

    void disconnect(String id) {
        Wand w = wands.get(id);
        if (w != null) w.drop();
    }

    // ---------- Scanning ----------

    private void startScan() {
        if (!running || scanning || !adapter.isEnabled()) return;
        BluetoothLeScanner scanner = adapter.getBluetoothLeScanner();
        if (scanner == null) {
            main.postDelayed(this::startScan, SCAN_RETRY_MS);
            return;
        }
        ScanSettings settings = new ScanSettings.Builder()
                .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
                .setCallbackType(ScanSettings.CALLBACK_TYPE_ALL_MATCHES)
                .build();
        // No filter: wands advertise their MCW- name but not always the service UUID,
        // and there is no name-prefix filter.
        scanner.startScan(null, settings, scanCallback);
        scanning = true;
        listener.onStatus("scanning", "Looking for wands");
        main.removeCallbacks(restartScan);
        main.postDelayed(restartScan, SCAN_RESTART_MS);
    }

    private void stopScan() {
        main.removeCallbacks(restartScan);
        if (!scanning) return;
        scanning = false;
        BluetoothLeScanner scanner = adapter.getBluetoothLeScanner();
        if (scanner != null && adapter.isEnabled()) scanner.stopScan(scanCallback);
    }

    private final Runnable restartScan = () -> {
        stopScan();
        startScan();
    };

    private final ScanCallback scanCallback = new ScanCallback() {
        @Override
        public void onScanResult(int callbackType, ScanResult result) {
            onAdvert(result);
        }

        @Override
        public void onBatchScanResults(List<ScanResult> results) {
            for (ScanResult r : results) onAdvert(r);
        }

        @Override
        public void onScanFailed(int errorCode) {
            scanning = false;
            listener.onStatus("scan-failed", "Bluetooth scan failed (" + errorCode + "), retrying");
            main.postDelayed(WandManager.this::startScan, SCAN_RETRY_MS);
        }
    };

    private void onAdvert(ScanResult result) {
        if (!running) return;
        BluetoothDevice device = result.getDevice();
        String id = device.getAddress();
        if (wands.containsKey(id)) return;
        Long after = retryAfter.get(id);
        if (after != null && SystemClock.elapsedRealtime() < after) return;

        ScanRecord rec = result.getScanRecord();
        String name = rec == null ? null : rec.getDeviceName();
        if (name == null) name = device.getName();
        boolean named = name != null && name.startsWith(NAME_PREFIX);
        boolean advertisesService = rec != null && rec.getServiceUuids() != null
                && rec.getServiceUuids().contains(new ParcelUuid(SERVICE));
        if (!named && !advertisesService) return;
        if (wands.size() >= MAX_WANDS) return;

        Wand w = new Wand(device, named ? name : NAME_PREFIX + id.replace(":", "").substring(6));
        wands.put(id, w);
        listener.onFound(w.id, w.name);
        connectQueue.add(w);
        pumpConnections();
    }

    private void pumpConnections() {
        if (!running || connecting != null) return;
        Wand next = connectQueue.poll();
        if (next == null) return;
        connecting = next;
        next.connect();
    }

    private void dropAll() {
        for (Wand w : new ArrayList<>(wands.values())) w.drop();
        connectQueue.clear();
        connecting = null;
    }

    private final BroadcastReceiver stateReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            int state = intent.getIntExtra(BluetoothAdapter.EXTRA_STATE, BluetoothAdapter.ERROR);
            if (state == BluetoothAdapter.STATE_ON) {
                startScan();
            } else if (state == BluetoothAdapter.STATE_TURNING_OFF || state == BluetoothAdapter.STATE_OFF) {
                scanning = false;
                main.removeCallbacks(restartScan);
                dropAll();
                listener.onStatus("bluetooth-off", "Bluetooth is off. Turn it on to find wands.");
            }
        }
    };

    // ---------- One wand ----------

    /** A GATT step. Returns true if a callback will report its completion. */
    private interface Op {
        boolean start();
    }

    private final class Wand extends BluetoothGattCallback {
        final BluetoothDevice device;
        final String id;
        final String name;
        BluetoothGatt gatt;
        BluetoothGattCharacteristic command;
        int writeType = BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT;
        boolean ready;
        boolean closed;

        private final ArrayDeque<Op> ops = new ArrayDeque<>();
        private Op current;
        private final Runnable opTimeout = () -> {
            current = null;
            next();
        };
        private final Runnable connectTimeout = this::drop;

        Wand(BluetoothDevice device, String name) {
            this.device = device;
            this.id = device.getAddress();
            this.name = name;
        }

        void connect() {
            main.postDelayed(connectTimeout, CONNECT_TIMEOUT_MS);
            gatt = device.connectGatt(ctx, false, this, BluetoothDevice.TRANSPORT_LE);
            if (gatt == null) drop();
        }

        /** Close the link and forget this wand; the scanner will find it again when it advertises. */
        void drop() {
            if (closed) return;
            closed = true;
            boolean wasConnecting = connecting == this;
            main.removeCallbacks(connectTimeout);
            main.removeCallbacks(opTimeout);
            ops.clear();
            current = null;
            ready = false;
            if (gatt != null) {
                gatt.disconnect();
                gatt.close();
            }
            wands.remove(id);
            connectQueue.remove(this);
            retryAfter.put(id, SystemClock.elapsedRealtime() + RETRY_COOLDOWN_MS);
            listener.onDisconnected(id);
            if (wasConnecting) {
                connecting = null;
                pumpConnections();
            }
        }

        // ----- operation queue -----

        void enqueue(Op op) {
            ops.add(op);
            next();
        }

        private void next() {
            while (current == null && !closed) {
                Op op = ops.poll();
                if (op == null) return;
                current = op;
                boolean waiting;
                try {
                    waiting = op.start();
                } catch (RuntimeException e) {
                    waiting = false;
                }
                if (waiting) {
                    main.postDelayed(opTimeout, OP_TIMEOUT_MS);
                    return;
                }
                current = null;
            }
        }

        private void opDone() {
            main.removeCallbacks(opTimeout);
            current = null;
            next();
        }

        void enqueueWrite(byte[] bytes) {
            enqueue(() -> writeCharacteristic(command, bytes, writeType));
        }

        // ----- setup, once services are known -----

        private void setUp() {
            BluetoothGattService svc = gatt.getService(SERVICE);
            BluetoothGattCharacteristic notify = svc == null ? null : svc.getCharacteristic(NOTIFY);
            command = svc == null ? null : svc.getCharacteristic(COMMAND);
            if (notify == null || command == null) {
                drop(); // an MCW- name but not a wand we understand
                return;
            }
            if ((command.getProperties() & BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE) != 0) {
                writeType = BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE;
            }
            enqueue(() -> gatt.requestMtu(MTU));
            enqueue(() -> enableNotifications(notify));

            BluetoothGattService bs = gatt.getService(BATTERY_SERVICE);
            BluetoothGattCharacteristic battery = bs == null ? null : bs.getCharacteristic(BATTERY_LEVEL);
            if (battery != null) {
                if ((battery.getProperties() & BluetoothGattCharacteristic.PROPERTY_NOTIFY) != 0) {
                    enqueue(() -> enableNotifications(battery));
                }
                enqueue(() -> gatt.readCharacteristic(battery));
            }
            enqueue(() -> {
                gatt.requestConnectionPriority(BluetoothGatt.CONNECTION_PRIORITY_HIGH);
                return false;
            });
            enqueue(() -> {
                ready = true;
                main.removeCallbacks(connectTimeout);
                listener.onConnected(id, name);
                if (connecting == this) {
                    connecting = null;
                    pumpConnections();
                }
                return false;
            });
        }

        private boolean enableNotifications(BluetoothGattCharacteristic ch) {
            if (!gatt.setCharacteristicNotification(ch, true)) return false;
            BluetoothGattDescriptor d = ch.getDescriptor(CCCD);
            if (d == null) return false;
            byte[] on = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                return gatt.writeDescriptor(d, on) == BluetoothStatusCodes.SUCCESS;
            }
            d.setValue(on);
            return gatt.writeDescriptor(d);
        }

        @SuppressWarnings("deprecation")
        private boolean writeCharacteristic(BluetoothGattCharacteristic ch, byte[] value, int type) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                return gatt.writeCharacteristic(ch, value, type) == BluetoothStatusCodes.SUCCESS;
            }
            ch.setWriteType(type);
            ch.setValue(value);
            return gatt.writeCharacteristic(ch);
        }

        private void deliver(UUID uuid, byte[] value) {
            if (closed || value == null || value.length == 0) return;
            if (NOTIFY.equals(uuid)) listener.onNotify(id, value);
            else if (BATTERY_LEVEL.equals(uuid)) listener.onBattery(id, value[0] & 0xFF);
        }

        // ----- callbacks (binder thread -> main) -----

        @Override
        public void onConnectionStateChange(BluetoothGatt g, int status, int newState) {
            main.post(() -> {
                if (closed) return;
                if (status == BluetoothGatt.GATT_SUCCESS && newState == BluetoothProfile.STATE_CONNECTED) {
                    enqueue(() -> gatt.discoverServices());
                } else {
                    drop();
                }
            });
        }

        @Override
        public void onServicesDiscovered(BluetoothGatt g, int status) {
            main.post(() -> {
                if (closed) return;
                if (status != BluetoothGatt.GATT_SUCCESS) {
                    drop();
                    return;
                }
                setUp();
                opDone();
            });
        }

        @Override
        public void onMtuChanged(BluetoothGatt g, int mtu, int status) {
            main.post(this::opDone);
        }

        @Override
        public void onDescriptorWrite(BluetoothGatt g, BluetoothGattDescriptor d, int status) {
            main.post(this::opDone);
        }

        @Override
        public void onCharacteristicWrite(BluetoothGatt g, BluetoothGattCharacteristic ch, int status) {
            main.post(this::opDone);
        }

        @Override
        public void onCharacteristicRead(BluetoothGatt g, BluetoothGattCharacteristic ch, byte[] value, int status) {
            byte[] copy = value.clone();
            UUID uuid = ch.getUuid();
            main.post(() -> {
                if (status == BluetoothGatt.GATT_SUCCESS) deliver(uuid, copy);
                opDone();
            });
        }

        @Override
        @SuppressWarnings("deprecation")
        public void onCharacteristicRead(BluetoothGatt g, BluetoothGattCharacteristic ch, int status) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) return; // the overload above handles it
            byte[] v = ch.getValue();
            byte[] copy = v == null ? null : v.clone();
            UUID uuid = ch.getUuid();
            main.post(() -> {
                if (status == BluetoothGatt.GATT_SUCCESS) deliver(uuid, copy);
                opDone();
            });
        }

        @Override
        public void onCharacteristicChanged(BluetoothGatt g, BluetoothGattCharacteristic ch, byte[] value) {
            byte[] copy = value.clone();
            UUID uuid = ch.getUuid();
            main.post(() -> deliver(uuid, copy));
        }

        @Override
        @SuppressWarnings("deprecation")
        public void onCharacteristicChanged(BluetoothGatt g, BluetoothGattCharacteristic ch) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) return; // the overload above handles it
            // Copy now: the stack reuses the characteristic's buffer for the next notification.
            byte[] v = ch.getValue();
            byte[] copy = v == null ? null : v.clone();
            UUID uuid = ch.getUuid();
            main.post(() -> deliver(uuid, copy));
        }
    }
}
