import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

const UPDATE_INTERVAL = 3; // seconds
const SMOOTH_SAMPLES  = 4; // readings to average for zone decision

function readFile(path) {
    try {
        const file = Gio.File.new_for_path(path);
        const [ok, contents] = file.load_contents(null);
        if (ok) return new TextDecoder().decode(contents).trim();
    } catch (_) {}
    return null;
}

function getCpuFreqInfo() {
    let sum = 0, count = 0, maxCur = 0;
    let maxBase = null, maxScale = null, maxHw = null, maxMin = null;
    let cpuIdx = 0;

    while (true) {
        const base = `/sys/devices/system/cpu/cpu${cpuIdx}/cpufreq`;
        const cur = readFile(`${base}/scaling_cur_freq`);
        if (cur === null) break;

        const f = parseInt(cur, 10);
        if (!isNaN(f)) { sum += f; count++; if (f > maxCur) maxCur = f; }

        const b = readFile(`${base}/base_frequency`);
        if (b) { const v = parseInt(b, 10); if (!maxBase || v > maxBase) maxBase = v; }

        const s = readFile(`${base}/scaling_max_freq`);
        if (s) { const v = parseInt(s, 10); if (!maxScale || v > maxScale) maxScale = v; }

        const h = readFile(`${base}/cpuinfo_max_freq`);
        if (h) { const v = parseInt(h, 10); if (!maxHw || v > maxHw) maxHw = v; }

        const mn = readFile(`${base}/scaling_min_freq`);
        if (mn) { const v = parseInt(mn, 10); if (!maxMin || v > maxMin) maxMin = v; }

        cpuIdx++;
        if (cpuIdx > 64) break;
    }

    return {
        avgKHz:    count > 0 ? Math.round(sum / count) : null,
        maxCurKHz: maxCur || null,
        baseKHz:   maxBase,
        maxKHz:    maxScale,
        hwMaxKHz:  maxHw,
        minKHz:    maxMin,
        coreCount: count,
    };
}

function freqZone(curKHz, baseKHz, maxKHz, hwMaxKHz, onAC, minKHz) {
    if (!curKHz || !baseKHz) return { label: '?', icon: '❓', color: '#888888' };

    const cappedByTlp = maxKHz && maxKHz <= baseKHz * 1.05;
    if (cappedByTlp) {
        if (onAC)
            return { label: 'cap', icon: '🔒', color: '#88aaff' };

        const floorKHz = minKHz || baseKHz * 0.30;
        const range    = baseKHz - floorKHz;
        const ratio    = range > 0 ? (curKHz - floorKHz) / range : 1;

        if (ratio < 0.15) return { label: 'idle', icon: '💤', color: '#888888' };
        if (ratio < 0.45) return { label: 'low',  icon: '🟢', color: '#559955' };
        if (ratio < 0.75) return { label: 'mid',  icon: '🔹', color: '#7799bb' };
        return               { label: 'cap',  icon: '🔒', color: '#88aaff' };
    }

    const ref   = maxKHz || hwMaxKHz || baseKHz;
    const range = ref - baseKHz;
    const ratio = range > 0 ? (curKHz - baseKHz) / range : 0;

    if (curKHz < baseKHz * 1.15)
        return { label: 'idle',  icon: '💤', color: '#888888' };

    if (onAC) {
        if (ratio < 0.35) return { label: 'low',   icon: '🟢', color: '#88cc88' };
        if (ratio < 0.65) return { label: 'mid',   icon: '🟡', color: '#ffcc00' };
        if (ratio < 0.90) return { label: 'high',  icon: '🟠', color: '#ff8800' };
        return              { label: 'boost', icon: '🔥', color: '#ff4444' };
    } else {
        if (ratio < 0.40) return { label: 'low',  icon: '🟢', color: '#559955' };
        if (ratio < 0.75) return { label: 'mid',  icon: '🔹', color: '#7799bb' };
        return              { label: 'cap',  icon: '🔒', color: '#88aaff' };
    }
}

function fmtFreq(khz) {
    if (!khz) return 'n/a';
    return (khz / 1_000_000).toFixed(2) + ' GHz';
}

function getMaxCpuTemp() {
    let maxTemp = null;
    let zoneIdx = 0;
    while (true) {
        const base = `/sys/class/thermal/thermal_zone${zoneIdx}`;
        const type = readFile(`${base}/type`);
        if (type === null) break;
        const tempStr = readFile(`${base}/temp`);
        if (tempStr !== null) {
            const t = parseInt(tempStr, 10);
            if (!isNaN(t) && (type === 'x86_pkg_temp' || type.startsWith('SEN') || type === 'acpitz')) {
                if (maxTemp === null || t > maxTemp) maxTemp = t;
            }
        }
        zoneIdx++;
        if (zoneIdx > 30) break;
    }
    return maxTemp !== null ? Math.round(maxTemp / 1000) : null;
}

function tempColor(temp) {
    if (temp === null) return '#888888';
    if (temp >= 90)    return '#ff4444';
    if (temp >= 75)    return '#ff8800';
    if (temp >= 60)    return '#ffcc00';
    return '#88cc88';
}

function getTlpSource() {
    const ac = readFile('/sys/class/power_supply/AC/online') ??
               readFile('/sys/class/power_supply/AC0/online') ??
               readFile('/sys/class/power_supply/ACAD/online');
    if (ac === null) return null;
    return ac === '1' ? 'AC' : 'BAT';
}

function getEPP() {
    return readFile('/sys/devices/system/cpu/cpu0/cpufreq/energy_performance_preference') ?? null;
}

function getPlatformProfile() {
    return readFile('/sys/firmware/acpi/platform_profile') ?? null;
}

function getCpuBoost() {
    const generic = readFile('/sys/devices/system/cpu/cpufreq/boost');
    if (generic !== null) return generic === '1' ? 'on' : 'off';
    const noTurbo = readFile('/sys/devices/system/cpu/intel_pstate/no_turbo');
    if (noTurbo !== null) return noTurbo === '0' ? 'on' : 'off';
    return null;
}

export default class CpuGovernorExtension extends Extension {
    enable() {
        this._freqHistory = [];

        this._indicator = new PanelMenu.Button(0.0, 'CPU FreqZone', false);

        // Panel bar label
        const box = new St.BoxLayout({ style_class: 'cpu-governor-box' });
        this._cpuLabel = new St.Label({
            text: '…',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'cpu-governor-label',
        });
        this._tempLabel = new St.Label({
            text: '',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'cpu-governor-label',
            style: 'margin-left: 6px;',
        });
        box.add_child(this._cpuLabel);
        box.add_child(this._tempLabel);
        this._indicator.add_child(box);

        // Helper: two-column key/value row
        const makeRow = (key) => {
            const item = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
            const row  = new St.BoxLayout({ style_class: 'cpu-freqzone-row', x_expand: true });
            const keyL = new St.Label({ text: key, style_class: 'cpu-freqzone-key' });
            const valL = new St.Label({ text: '…', style_class: 'cpu-freqzone-val', x_expand: true });
            row.add_child(keyL);
            row.add_child(valL);
            item.add_child(row);
            return { item, valL };
        };

        const makeSectionLabel = (text) => {
            const item = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
            const lbl  = new St.Label({ text, style_class: 'cpu-freqzone-section-label', x_expand: true });
            item.add_child(lbl);
            return item;
        };

        // --- Section: Frequency ---
        this._indicator.menu.addMenuItem(makeSectionLabel('Frequency'));

        ({ item: this._zoneMenuItem,    valL: this._zoneVal    } = makeRow('Zone'));
        ({ item: this._maxCoreMenuItem, valL: this._maxCoreVal } = makeRow('Max core'));
        ({ item: this._avgMenuItem,     valL: this._avgVal     } = makeRow('Avg'));
        ({ item: this._capMenuItem,     valL: this._capVal     } = makeRow('Cap'));
        ({ item: this._hwMaxMenuItem,   valL: this._hwMaxVal   } = makeRow('HW max'));

        this._indicator.menu.addMenuItem(this._zoneMenuItem);
        this._indicator.menu.addMenuItem(this._maxCoreMenuItem);
        this._indicator.menu.addMenuItem(this._avgMenuItem);
        this._indicator.menu.addMenuItem(this._capMenuItem);
        this._indicator.menu.addMenuItem(this._hwMaxMenuItem);

        this._indicator.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // --- Section: System ---
        this._indicator.menu.addMenuItem(makeSectionLabel('System'));

        ({ item: this._tempMenuItem,    valL: this._tempVal    } = makeRow('Temp'));
        ({ item: this._powerMenuItem,   valL: this._powerVal   } = makeRow('Power'));
        ({ item: this._govMenuItem,     valL: this._govVal     } = makeRow('Governor'));
        ({ item: this._eppMenuItem,     valL: this._eppVal     } = makeRow('EPP'));
        ({ item: this._profileMenuItem, valL: this._profileVal } = makeRow('Profile'));
        ({ item: this._boostMenuItem,   valL: this._boostVal   } = makeRow('Boost'));

        this._indicator.menu.addMenuItem(this._tempMenuItem);
        this._indicator.menu.addMenuItem(this._powerMenuItem);
        this._indicator.menu.addMenuItem(this._govMenuItem);
        this._indicator.menu.addMenuItem(this._eppMenuItem);
        this._indicator.menu.addMenuItem(this._profileMenuItem);
        this._indicator.menu.addMenuItem(this._boostMenuItem);

        Main.panel.addToStatusArea(this.uuid, this._indicator, 1, 'right');

        this._update();
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, UPDATE_INTERVAL, () => {
            this._update();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _update() {
        const freq    = getCpuFreqInfo();
        const temp    = getMaxCpuTemp();
        const tlp     = getTlpSource();
        const epp     = getEPP();
        const profile = getPlatformProfile();
        const boost   = getCpuBoost();
        const gov     = readFile('/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor') ?? '?';
        const onAC    = tlp === 'AC';

        if (freq.maxCurKHz) {
            this._freqHistory.push(freq.maxCurKHz);
            if (this._freqHistory.length > SMOOTH_SAMPLES)
                this._freqHistory.shift();
        }
        const smoothedFreq = this._freqHistory.length > 0
            ? Math.round(this._freqHistory.reduce((a, b) => a + b, 0) / this._freqHistory.length)
            : freq.maxCurKHz;

        const zone = freqZone(smoothedFreq, freq.baseKHz, freq.maxKHz, freq.hwMaxKHz, onAC, freq.minKHz);

        // Panel bar
        this._cpuLabel.set_text(`${zone.icon} ${zone.label}  ${fmtFreq(freq.maxCurKHz)}`);
        this._cpuLabel.set_style(`color: ${zone.color};`);

        if (temp !== null) {
            this._tempLabel.set_text(`🌡 ${temp}°C`);
            this._tempLabel.set_style(`margin-left: 6px; color: ${tempColor(temp)};`);
        } else {
            this._tempLabel.set_text('');
        }

        // Frequency section
        this._zoneVal.set_text(`${zone.icon} ${zone.label}  (${onAC ? 'AC' : 'BAT'})`);
        this._zoneVal.set_style(`color: ${zone.color}; padding-left: 8px;`);

        this._maxCoreVal.set_text(fmtFreq(freq.maxCurKHz));
        this._avgVal.set_text(fmtFreq(freq.avgKHz));
        this._capVal.set_text(fmtFreq(freq.maxKHz));
        this._hwMaxVal.set_text(fmtFreq(freq.hwMaxKHz));

        // System section
        if (temp !== null) {
            this._tempVal.set_text(`${temp}°C`);
            this._tempVal.set_style(`color: ${tempColor(temp)}; padding-left: 8px;`);
        } else {
            this._tempVal.set_text('n/a');
            this._tempVal.set_style('padding-left: 8px;');
        }

        this._powerVal.set_text(tlp ?? 'n/a');
        this._govVal.set_text(gov);
        this._eppVal.set_text(epp ?? 'n/a');
        this._profileVal.set_text(profile ?? 'n/a');
        this._boostVal.set_text(boost !== null ? boost : 'n/a');
    }

    disable() {
        if (this._timer) {
            GLib.source_remove(this._timer);
            this._timer = null;
        }
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
        this._freqHistory = [];
    }
}
