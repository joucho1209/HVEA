// ==UserScript==
// @name         HV装备助手
// @name:en      HV Equipment Assistant
// @namespace    HVEA
// @version      1.0.0
// @homepageURL  https://github.com/joucho1209/HVEA
// @icon         https://hentaiverse.org/y/favicon.png
// @updateURL    https://raw.githubusercontent.com/joucho1209/HVEA/main/HV%20Equipment%20Assistant%201.0.0.js
// @downloadURL  https://raw.githubusercontent.com/joucho1209/HVEA/main/HV%20Equipment%20Assistant%201.0.0.js
// @author       joucho
// @description  融合顺序材料计算、装备强化预览/材料计算
// @match        *://hentaiverse.org/*
// @match        *://*.hentaiverse.org/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addStyle
// @grant        unsafeWindow
// @connect      hentaiverse.org
// @connect      alt.hentaiverse.org
// @run-at       document-end
// ==/UserScript==

function makeDraggable(target, handle, onStop) {
  if (!target || !handle) return;
  handle.style.cursor = "move";
  let dragging = false;
  let startX = 0;
  let startY = 0;
  let startLeft = 0;
  let startTop = 0;
  const move = (event) => {
    if (!dragging) return;
    target.style.left = `${startLeft + event.clientX - startX}px`;
    target.style.top = `${startTop + event.clientY - startY}px`;
    target.style.right = "auto";
  };
  const stop = () => {
    if (!dragging) return;
    dragging = false;
    document.removeEventListener("mousemove", move);
    document.removeEventListener("mouseup", stop);
    onStop?.(target);
  };
  handle.addEventListener("mousedown", (event) => {
    if (event.button !== 0 || event.target?.closest?.("button, input, select, textarea")) return;
    const rect = target.getBoundingClientRect();
    const isFixed = window.getComputedStyle(target).position === "fixed";
    startX = event.clientX;
    startY = event.clientY;
    startLeft = rect.left + (isFixed ? 0 : window.scrollX || document.documentElement.scrollLeft || 0);
    startTop = rect.top + (isFixed ? 0 : window.scrollY || document.documentElement.scrollTop || 0);
    dragging = true;
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", stop);
    event.preventDefault();
  });
}

// 全局轻提示：融合模块与材料面板共用同一元素与样式
let hvToastTimer = null;
let hvToastElement = null;

function getToastElement() {
  if (!hvToastElement || !hvToastElement.isConnected) {
    hvToastElement = document.getElementById("hv-minsteps-toast") || document.createElement("div");
    if (!hvToastElement.id) {
      hvToastElement.id = "hv-minsteps-toast";
      hvToastElement.className = "hv-ms-toast";
      hvToastElement.setAttribute("role", "status");
      hvToastElement.setAttribute("aria-live", "polite");
      document.body.appendChild(hvToastElement);
    }
  }
  return hvToastElement;
}

function showToast(message, type = "") {
  const toast = getToastElement();
  window.clearTimeout(hvToastTimer);
  toast.textContent = message;
  toast.className = `hv-ms-toast ${type} show`.trim();
  hvToastTimer = window.setTimeout(() => {
    toast.classList.remove("show");
  }, 2200);
}

(function() {
  'use strict';

  const IS_ISEKAI_PAGE = /\/isekai(?:\/|$)/i.test(location.pathname || '');
  const LEGACY_STORAGE_KEY_TANK = 'HV_TankSettings';
  const STORAGE_KEY_TANK = `HV_TankSettings_${IS_ISEKAI_PAGE ? 'isekai' : 'main'}`;
  const BASE_STATS_CACHE_KEY = 'HV_BasePrimaryStats';
  const BASE_STATS_CACHE_TTL = 5 * 60 * 1000;

  const QUALITY_CAP = {
    'Superior': 10,
    'Exquisite': 10,
    'Magnificent': 20,
    'Legendary': 25,
    'Peerless': 30,
    'Ultimate': 33,
  };
  const DEFAULT_CAP = 10;

  const QUALITY_CODE_MAP = {
    4: 'Superior',
    5: 'Exquisite',
    6: 'Magnificent',
    7: 'Legendary',
    8: 'Peerless',
    9: 'Ultimate',
  };

  const QUALITY_SEARCH_TERMS = Object.keys(QUALITY_CAP)
    .sort((a, b) => b.length - a.length);

  function extractQualityFromName(name) {
    const text = String(name || '');
    return QUALITY_SEARCH_TERMS.find(term => text.includes(term)) || null;
  }

  function getQualityFromCode(code) {
    const q = Number(code);
    return Number.isFinite(q) && QUALITY_CODE_MAP[q] ? QUALITY_CODE_MAP[q] : null;
  }

  function getQualityCap(quality) {
    const cap = QUALITY_CAP[quality];
    return cap !== undefined ? cap : DEFAULT_CAP;
  }

  const PANEL_ROW_NAME_MAP = {
    'Attack Accuracy': 'Accuracy',
    'Attack Crit Damage': 'Crit Multiplier',
    'Attack Speed': 'Attack Speed Bonus',
    'Casting Speed': 'Cast Speed Bonus',
    'Magic Damage': 'Damage Bonus',
    'Magic Accuracy': 'Accuracy',
    'Magic Crit Damage': 'Crit Multiplier',
    'Mana Conservation': 'Mana Cost Modifier',
    'Mana Cost': 'Mana Cost Modifier',
    'Physical Mitigation': 'Physical',
    'Magical Mitigation': 'Magical',
    'Counter Resist': 'Counter-resist',
  };

  const DIRECT_STAT_SECTION_MAP = {
    'Attack Damage': 'mainhand',
    'Attack Accuracy': 'mainhand',
    'Attack Crit Damage': 'mainhand',
    'Attack Speed': 'mainhand',
    'Crushing Damage': 'mainhand',
    'Slashing Damage': 'mainhand',
    'Piercing Damage': 'mainhand',
    'Void Damage': 'mainhand',
    'Magic Damage': 'magic',
    'Magic Accuracy': 'magic',
    'Magic Crit Damage': 'magic',
    'Casting Speed': 'magic',
    'Mana Conservation': 'magic',
    'Mana Cost': 'magic',
    'Counter-resist': 'magic',
  };

  function cleanName(str) {
    return str.replace(/[()\-:，,、\s]/g, '').toLowerCase();
  }

  function cleanPanelDisplayName(panelName) {
    let cleaned = panelName.replace(/^\[\d+\]\s*/, '');
    return cleaned || panelName;
  }

  function getTableSectionTitle(table) {
    if (!table) return '';
    let previous = table.previousElementSibling;
    while (previous && !previous.classList?.contains('spc')) {
      previous = previous.previousElementSibling;
    }
    return previous?.classList?.contains('spc') ? previous.textContent.trim() : '';
  }

  function getPanelSection(sectionTitle) {
    if (sectionTitle.includes('Mainhand Attack')) return 'mainhand';
    if (sectionTitle.includes('Offhand Attack')) return 'offhand';
    if (sectionTitle.includes('Magic Attack')) return 'magic';
    if (sectionTitle.includes('Avoidance')) return 'avoidance';
    if (sectionTitle.includes('Damage Mitigation')) return 'mitigation';
    if (sectionTitle.includes('Spell Damage Bonus')) return 'spell';
    if (sectionTitle.includes('Effective Primary Stats')) return 'primary';
    if (sectionTitle.includes('Proficiency')) return 'proficiency';
    if (sectionTitle.includes('Vitals')) return 'vitals';
    if (sectionTitle.includes('Compromise')) return 'compromise';
    return 'general';
  }

  function buildStatsPanelIndex(root) {
    const tables = [];

    root.querySelectorAll('table').forEach(table => {
      const tableRows = [];
      table.querySelectorAll('tr').forEach(tr => {
        const td1 = tr.cells[0];
        const td2 = tr.cells[1];
        if (!td1 || !td2) return;

        const panelName = td2.textContent.trim();
        const panelValue = td1.textContent.trim();
        tableRows.push({
          tr,
          td1,
          td2,
          panelName,
          isPercent: panelValue.includes('%'),
          normalizedMatchName: cleanName(cleanPanelDisplayName(panelName)),
        });
      });
      tables.push({ rows: tableRows });
    });

    return { tables };
  }

  function getStatsPanelIndex() {
    const root = document.getElementById('stats_scrollable');
    if (!root) return null;
    return buildStatsPanelIndex(root);
  }


  function normalizeNames(names) {
    const normalized = [];
    const seen = new Set();
    for (const name of names) {
      const cleaned = cleanName(name || '');
      if (cleaned && !seen.has(cleaned)) {
        seen.add(cleaned);
        normalized.push(cleaned);
      }
    }
    return normalized;
  }

  function findFirstPanelItem(items, normalizedNames) {
    if (!items || normalizedNames.length === 0) return null;
    const names = new Set(normalizedNames);
    return items.find(item => names.has(item.normalizedMatchName)) || null;
  }

  let gEnglishStatsPanel = null;
  let gEnglishStatsPanelAt = 0;
  let gEnglishStatsPanelRequest = null;
  const ENGLISH_PANEL_CACHE_TTL = 60 * 1000;

  function buildEnglishStatsPanel(doc) {
    const root = doc.getElementById('stats_scrollable');
    if (!root) return null;

    const sections = [];
    const bySectionKey = new Map();
    root.querySelectorAll('table').forEach(table => {
      const sectionKey = getPanelSection(getTableSectionTitle(table));
      const rows = [];
      table.querySelectorAll('tr').forEach(tr => {
        const td1 = tr.cells[0];
        const td2 = tr.cells[1];
        if (!td1 || !td2) return;
        const valueText = td1.textContent.trim();
        const name = cleanPanelDisplayName(td2.textContent.trim());
        const value = parseFloat(valueText.replace(/,/g, '').replace(/%/g, ''));
        if (isNaN(value)) return;
        rows.push({
          name,
          value,
          normalizedName: cleanName(name),
        });
      });
      if (!rows.length) return;
      const section = { rows };
      sections.push(section);
      if (!bySectionKey.has(sectionKey)) bySectionKey.set(sectionKey, []);
      bySectionKey.get(sectionKey).push(section);
    });

    return {
      sections,
      bySectionKey,
    };
  }


  function ensureEnglishStatsPanel(force) {
    if (!force && gEnglishStatsPanel &&
      Date.now() - gEnglishStatsPanelAt < ENGLISH_PANEL_CACHE_TTL) {
      return Promise.resolve(gEnglishStatsPanel);
    }
    if (!force && gEnglishStatsPanelRequest) return gEnglishStatsPanelRequest;

    const baseUrl = location.origin + location.pathname;
    const sep = baseUrl.includes('?') ? '&' : '?';
    const url = `${baseUrl}${sep}s=Character&ss=eq`;

    gEnglishStatsPanelRequest = new Promise(resolve => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        timeout: 10000,
        onload(response) {
          if (response.status !== 200) {
            resolve(null);
            return;
          }
          try {
            const doc = new DOMParser().parseFromString(response.responseText, 'text/html');
            const panel = buildEnglishStatsPanel(doc);
            if (panel) {
              gEnglishStatsPanel = panel;
              gEnglishStatsPanelAt = Date.now();
            }
            resolve(panel);
          } catch (e) {
            resolve(null);
          }
        },
        onerror() {
          resolve(null);
        },
        ontimeout() {
          resolve(null);
        },
      });
    });
    gEnglishStatsPanelRequest.then(
      () => { gEnglishStatsPanelRequest = null; },
      () => { gEnglishStatsPanelRequest = null; }
    );
    return gEnglishStatsPanelRequest;
  }

  const KNOWN_PANEL_SECTION_KEYS = new Set([
    'mainhand', 'offhand', 'magic', 'avoidance', 'mitigation', 'spell',
    'primary', 'proficiency', 'vitals', 'compromise', 'general',
  ]);

  function findEnglishPanelRow(sectionKey, title) {
    if (!gEnglishStatsPanel) return null;
    const aliases = normalizeNames([title, PANEL_ROW_NAME_MAP[title]]);
    if (!aliases.length) return null;
    const sections = KNOWN_PANEL_SECTION_KEYS.has(sectionKey)
      ? (gEnglishStatsPanel.bySectionKey.get(sectionKey) || [])
      : gEnglishStatsPanel.sections;
    for (const section of sections) {
      for (const row of section.rows) {
        if (aliases.includes(row.normalizedName)) return row;
      }
    }
    return null;
  }

  function alignLiveTableToEnglishSection(liveIndex, enSection) {
    if (!liveIndex || !liveIndex.tables || !liveIndex.tables.length) return null;

    const enRows = enSection.rows;
    let best = null;
    let bestScore = -Infinity;
    for (const table of liveIndex.tables) {
      const liveRows = table.rows;
      let positional = 0;
      let unordered = 0;
      const liveValues = new Set(liveRows.map(row => {
        const value = parseFloat(row.td1.textContent.trim().replace(/,/g, '').replace(/%/g, ''));
        return Number.isFinite(value) ? value.toFixed(2) : null;
      }).filter(Boolean));
      for (let i = 0; i < enRows.length; i++) {
        const liveRow = liveRows[i];
        if (liveRow) {
          const liveValue = parseFloat(liveRow.td1.textContent.trim().replace(/,/g, '').replace(/%/g, ''));
          if (Number.isFinite(liveValue) && Math.abs(liveValue - enRows[i].value) < 0.01) positional++;
        }
        if (liveValues.has(enRows[i].value.toFixed(2))) unordered++;
      }
      const score = unordered * 100 + positional * 5 - Math.abs(enRows.length - liveRows.length) * 20;
      if (score > bestScore) {
        bestScore = score;
        best = table;
      }
    }
    if (best && bestScore > 0) return best;

    const enIndex = gEnglishStatsPanel ? gEnglishStatsPanel.sections.indexOf(enSection) : -1;
    return (enIndex >= 0 && liveIndex.tables[enIndex]) ? liveIndex.tables[enIndex] : null;
  }

  function findLiveRowByEnglishRow(sectionKey, enRow) {
    const liveIndex = getStatsPanelIndex();
    if (!liveIndex || !gEnglishStatsPanel) return null;

    const enSection = gEnglishStatsPanel.sections.find(section => section.rows.includes(enRow));
    if (!enSection) return null;

    const liveTable = alignLiveTableToEnglishSection(liveIndex, enSection);
    const liveItems = liveTable ? liveTable.rows : [];
    if (!liveItems.length) return null;

    const valueMatches = liveItems.filter(item => {
      const value = parseFloat(item.td1.textContent.trim().replace(/,/g, '').replace(/%/g, ''));
      return Number.isFinite(value) && Math.abs(value - enRow.value) < 0.01;
    });
    if (valueMatches.length === 1) return valueMatches[0];

    const aliasMatch = findFirstPanelItem(
      liveItems,
      normalizeNames([enRow.name, PANEL_ROW_NAME_MAP[enRow.name]])
    );
    if (aliasMatch) return aliasMatch;

    const enIndex = enSection.rows.indexOf(enRow);
    if (enIndex >= 0 && enIndex < liveItems.length) return liveItems[enIndex];
    return null;
  }

  function readLiveRowIncrement(item) {
    if (!item || !item.td1 || !item.td2) return { base: 0, increment: 0, value: 0 };
    const baseValue = parseFloat(item.td1.textContent.trim().replace(/,/g, '').replace(/%/g, ''));
    let increment = 0;
    item.td2.querySelectorAll('.hv-panel-increment').forEach(node => {
      const value = parseFloat(node.textContent.trim().replace(/,/g, '').replace(/[+%]/g, ''));
      if (!isNaN(value)) increment += value;
    });
    return {
      base: isNaN(baseValue) ? 0 : baseValue,
      increment,
      value: (isNaN(baseValue) ? 0 : baseValue) + increment,
    };
  }

  const COUNTER_RESIST_CHARM_BONUS = Object.freeze({
    greater: 20,
    lesser: 12,
  });
  const COUNTER_RESIST_CHARM_STORAGE_KEY = 'hv-counter-resist-charm-cache-v3';
  const COUNTER_RESIST_CHARM_CACHE = new Map();
  const COUNTER_RESIST_CHARM_REQUESTS = new Map();
  const COUNTER_RESIST_CHARM_STATUS = new Map();
  const COUNTER_RESIST_CHARM_RETRY_AT = new Map();
  const CHARM_INFO_STORAGE_KEY = 'hv-charm-info-cache-v3';
  const CHARM_INFO_CACHE_TTL = 5 * 60 * 1000;
  const CHARM_INFO_CACHE = new Map();
  const CHARM_INFO_CACHE_AT = new Map();
  const CHARM_INFO_REQUESTS = new Map();
  const CHARM_INFO_STATUS = new Map();
  const CHARM_INFO_RETRY_AT = new Map();

  function getCounterResistCharmNameBonus(value) {
    const text = String(value || '');
    const compact = text.replace(/[\s\u200B-\u200D\uFEFF]/g, '');
    const isCounterResist = /(?:counter[- ]*resist|反抵抗率|反抵抗|penetrator)/i.test(text) ||
      compact.includes('反抵抗率') || compact.includes('反抵抗') ||
      compact.toLowerCase().includes('penetrator');
    if (!isCounterResist) return 0;
    if (/(?:greater|major|large|\(\s*g\s*\)|\uFF08\s*大(?:型)?\s*\uFF09|大型|大护符)/i.test(text) ||
      /(?:greater|major|large|大(?:型)?)/i.test(compact)) {
      return COUNTER_RESIST_CHARM_BONUS.greater;
    }
    if (/(?:lesser|minor|small|\(\s*l\s*\)|\uFF08\s*小(?:型)?\s*\uFF09|小型|小护符)/i.test(text) ||
      /(?:lesser|minor|small|小(?:型)?)/i.test(compact)) {
      return COUNTER_RESIST_CHARM_BONUS.lesser;
    }
    return 0;
  }

  const CHARM_DEFS = Object.freeze({
    archmage: Object.freeze({
      label: '武器魔法伤害',
      category: 'attack',
      sizes: Object.freeze({
        lesser: Object.freeze({
          staff: { weaponMagicDamage: 6, percent: true },
          onehand: { weaponMagicDamage: level => Math.ceil(level / 5) + 6 },
          twohand: { weaponMagicDamage: level => Math.ceil(level / 5) * 2.12 },
        }),
        greater: Object.freeze({
          staff: { weaponMagicDamage: 10, percent: true },
          onehand: { weaponMagicDamage: level => Math.ceil(level / 3) * 1.1 },
          twohand: { weaponMagicDamage: level => Math.ceil(level / 3) * 2.2 },
        }),
      }),
    }),
    economizer: Object.freeze({
      label: '魔力消耗减免',
      category: 'attack',
      sizes: Object.freeze({
        lesser: Object.freeze({
          onehand: { manaCostReduction: 10 },
          twohand: { manaCostReduction: 15 },
          staff: { manaCostReduction: 15 },
        }),
        greater: Object.freeze({
          onehand: { manaCostReduction: 15 },
          twohand: { manaCostReduction: 25 },
          staff: { manaCostReduction: 25 },
        }),
      }),
    }),
    spellweaver: Object.freeze({
      label: '施法速度',
      category: 'attack',
      sizes: Object.freeze({
        lesser: { any: { castSpeed: 5 } },
        greater: { any: { castSpeed: 7.5 } },
      }),
    }),
    annihilator: Object.freeze({
      label: '魔法暴击伤害',
      category: 'attack',
      sizes: Object.freeze({
        lesser: { any: { critDamage: 0.06 } },
        greater: { any: { critDamage: 0.1 } },
      }),
    }),
    penetrator: Object.freeze({
      label: '反抵抗',
      category: 'attack',
      sizes: Object.freeze({
        lesser: { any: { counterResist: 12 } },
        greater: { any: { counterResist: 20 } },
      }),
    }),
    aether: Object.freeze({
      label: '以太',
      category: 'attack',
      sizes: Object.freeze({
        lesser: Object.freeze({
          any: { maccPercent: 20, maccFlat: 10 },
          onehand: { manaCostReduction: 3, maccPercent: 20, maccFlat: 10 },
          twohand: { manaCostReduction: 3, maccPercent: 20, maccFlat: 10 },
          staff: { manaCostReduction: 6, maccPercent: 20, maccFlat: 10 },
        }),
        greater: Object.freeze({
          any: { maccPercent: 30, maccFlat: 10 },
          onehand: { manaCostReduction: 5, maccPercent: 30, maccFlat: 10 },
          twohand: { manaCostReduction: 5, maccPercent: 30, maccFlat: 10 },
          staff: { manaCostReduction: 10, maccPercent: 30, maccFlat: 10 },
        }),
      }),
    }),
    juggernaut: Object.freeze({
      label: '生命',
      category: 'defense',
      sizes: Object.freeze({
        lesser: { any: { maxHealthPercent: 6 } },
        greater: { any: { maxHealthPercent: 10 } },
      }),
    }),
    capacitor: Object.freeze({
      label: '魔力',
      category: 'defense',
      sizes: Object.freeze({
        lesser: { any: { maxManaPercent: 6 } },
        greater: { any: { maxManaPercent: 10 } },
      }),
    }),
  });

  const CHARM_SLOT_KEY_BY_ID = Object.freeze({
    1: 'main',
    2: 'off',
    13: 'helmet',
    11: 'body',
    14: 'hands',
    12: 'legs',
    15: 'feet',
  });
  const CHARM_SLOT_LABELS = Object.freeze({
    main: '主手',
    off: '副手',
    helmet: '头盔',
    body: '身体',
    hands: '手部',
    legs: '腿部',
    feet: '足部',
  });
  const CHARM_SLOT_KEYS = Object.freeze(['main', 'off', 'helmet', 'body', 'hands', 'legs', 'feet']);
  const CHARM_SLOT_MULTIPLIERS = Object.freeze({
    off: 1,
    helmet: 1,
    body: 1.2,
    hands: 0.9,
    legs: 1.1,
    feet: 0.8,
  });

  function getCharmSlotKey(slot, index) {
    const slotId = Number(slot?.slotId);
    if (slotId != null && CHARM_SLOT_KEY_BY_ID[slotId]) return CHARM_SLOT_KEY_BY_ID[slotId];
    if (index === 0) return 'main';
    if (index === 1) return 'off';
    return null;
  }

  function getCharmSlotMultiplier(key) {
    return Number(CHARM_SLOT_MULTIPLIERS[key] ?? 1);
  }

  function createZeroCharmEffect() {
    return {
      weaponMagicDamage: 0,
      manaCostReduction: 0,
      castSpeed: 0,
      critDamage: 0,
      counterResist: 0,
      maccPercent: 0,
      maccFlat: 0,
      maxHealthPercent: 0,
      maxManaPercent: 0,
    };
  }

  function getCharmEffect(type, size, weaponClass, level) {
    const def = CHARM_DEFS[type];
    const sizeSpec = def?.sizes?.[size];
    if (!sizeSpec) return createZeroCharmEffect();
    const spec = sizeSpec[weaponClass] || sizeSpec.any || null;
    if (!spec) return createZeroCharmEffect();
    const lv = Math.max(0, Number(level) || 0);
    const effect = createZeroCharmEffect();
    Object.entries(spec).forEach(([field, value]) => {
      effect[field] = typeof value === 'function' ? value(lv) : value;
    });
    return effect;
  }

  function normalizeCharmWeaponClass(weaponType) {
    const text = String(weaponType || '').toLowerCase();
    if (text.includes('staff')) return 'staff';
    if (text.includes('two') || text.includes('2h') || text.includes('双手')) return 'twohand';
    if (text.includes('one') || text.includes('1h') || text.includes('单手')) return 'onehand';
    if (text.includes('shield') || text.includes('盾')) return 'shield';
    return '';
  }

  function parseCharmNameToInfo(text) {
    const raw = String(text || '');
    const compact = raw.replace(/[\s\u200B-\u200D\uFEFF]/g, '').toLowerCase();
    if (!compact || /empty|unused|空/.test(compact)) return null;
    let type = null;
    for (const [key, def] of Object.entries(CHARM_DEFS)) {
      if (compact.includes(key) || compact.includes(String(def.label || '').toLowerCase())) {
        type = key;
        break;
      }
    }
    if (!type) return null;
    let size = null;
    if (/(greater|major|large|大型|大)/.test(compact)) size = 'greater';
    else if (/(lesser|minor|small|小型|小)/.test(compact)) size = 'lesser';
    if (!size) return null;
    return { type, size };
  }

  function getEquipmentCharmInfoFromDoc(doc) {
    if (!doc || typeof doc.querySelectorAll !== 'function') return [];
    const names = [];
    doc.querySelectorAll('.eqcharm th').forEach(th => {
      const text = String(th.textContent || '').trim();
      if (text) names.push(text);
    });
    if (!names.length) {
      doc.querySelectorAll('.eqcharm').forEach(node => {
        const text = String(node.textContent || '').trim();
        if (text) names.push(text);
      });
    }
    const charms = [];
    const seenTypes = new Set();
    for (const name of names) {
      const info = parseCharmNameToInfo(name);
      if (info && !seenTypes.has(info.type)) {
        seenTypes.add(info.type);
        charms.push(info);
      }
    }
    return charms;
  }

  const COUNTER_RESIST_CHARM_AJAX_INTERVAL = 300;
  const COUNTER_RESIST_CHARM_AJAX_MAX = 4;
  const COUNTER_RESIST_CHARM_AJAX_QUEUE = [];
  let counterResistCharmAjaxActive = 0;
  let counterResistCharmAjaxLastStart = 0;
  let counterResistCharmAjaxTimer = null;

  function pumpCounterResistCharmAjaxQueue() {
    if (!COUNTER_RESIST_CHARM_AJAX_QUEUE.length ||
      counterResistCharmAjaxActive >= COUNTER_RESIST_CHARM_AJAX_MAX) return;

    const elapsed = Date.now() - counterResistCharmAjaxLastStart;
    const wait = Math.max(0, COUNTER_RESIST_CHARM_AJAX_INTERVAL - elapsed);
    if (wait > 0) {
      if (counterResistCharmAjaxTimer === null) {
        counterResistCharmAjaxTimer = window.setTimeout(() => {
          counterResistCharmAjaxTimer = null;
          pumpCounterResistCharmAjaxQueue();
        }, wait);
      }
      return;
    }

    const job = COUNTER_RESIST_CHARM_AJAX_QUEUE.shift();
    counterResistCharmAjaxActive++;
    counterResistCharmAjaxLastStart = Date.now();
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      counterResistCharmAjaxActive = Math.max(0, counterResistCharmAjaxActive - 1);
      pumpCounterResistCharmAjaxQueue();
    };

    try {
      job(release);
    } catch (e) {
      release();
    }
    pumpCounterResistCharmAjaxQueue();
  }

  function enqueueCounterResistCharmAjax(job) {
    if (typeof job !== 'function') return;
    COUNTER_RESIST_CHARM_AJAX_QUEUE.push(job);
    pumpCounterResistCharmAjaxQueue();
  }

  try {
    const storedCharmCache = typeof GM_getValue === 'function'
      ? GM_getValue(COUNTER_RESIST_CHARM_STORAGE_KEY, '')
      : '';
    const parsedCharmCache = typeof storedCharmCache === 'string'
      ? JSON.parse(storedCharmCache || '{}')
      : storedCharmCache;
    if (parsedCharmCache && typeof parsedCharmCache === 'object') {
      Object.entries(parsedCharmCache).forEach(([eid, bonus]) => {
        const equipmentId = Number(eid);
        const value = Number(bonus);
        if (equipmentId > 0 && value > 0) COUNTER_RESIST_CHARM_CACHE.set(equipmentId, value);
      });
    }
  } catch (e) {}

  function persistCounterResistCharmCache() {
    if (typeof GM_setValue !== 'function') return;
    try {
      GM_setValue(
        COUNTER_RESIST_CHARM_STORAGE_KEY,
        JSON.stringify(Object.fromEntries(COUNTER_RESIST_CHARM_CACHE.entries()))
      );
    } catch (e) {}
  }

  function getEquipmentModifyFilter(name = '', weaponType = '') {
    const type = `${weaponType} ${name}`.toLowerCase();

    if (type.includes('staff')) return 'weapon_staff';
    if (type.includes('one-handed')) return 'weapon_onehand';
    if (type.includes('two-handed')) return 'weapon_twohand';
    if (/buckler|kite shield|tower shield|force shield/.test(type)) return 'shield';
    if (type.includes('cloth armor')) return 'armor_cloth';
    if (type.includes('light armor')) return 'armor_light';
    if (type.includes('heavy armor')) return 'armor_heavy';
    return '';
  }

  function getCounterResistCharmBonus(root) {
    if (!root || typeof root.querySelectorAll !== 'function') return 0;

    const charmNodes = root.querySelectorAll('.eqcharm th');
    const fallbackNodes = root.querySelectorAll('.chm');
    const charmContainers = root.querySelectorAll('.eqcharm, .chm');
    const charmNames = charmNodes.length
      ? Array.from(charmNodes, node => String(node.textContent || '').trim())
      : fallbackNodes.length
        ? Array.from(fallbackNodes, node => String(node.textContent || '').trim())
        : charmContainers.length
          ? Array.from(charmContainers, node => String(node.textContent || '').trim())
          : [];

    let bonus = 0;
    for (const text of charmNames) {
      bonus += getCounterResistCharmNameBonus(text);
    }
    return bonus;
  }

  function getCounterResistCharmBonusFromHtml(html) {
    const source = String(html || '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;|&#160;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
      .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(parseInt(code, 10)));

    let bonus = 0;
    const matches = source.match(/(?:counter[\s-]*resist|反抵抗率|反抵抗|penetrator)[^\r\n]{0,100}/gi) || [];
    for (const match of matches) {
      bonus += getCounterResistCharmNameBonus(match);
    }
    return bonus;
  }

  function getCounterResistCharmBonusForEquipment(eid) {
    if (!eid || typeof document === 'undefined') return 0;

    const eidPattern = new RegExp(`/equip/${Number(eid)}(?:/|[?#]|$)`, 'i');
    for (const frame of document.querySelectorAll('iframe[src]')) {
      const src = frame.getAttribute('src') || '';
      if (!eidPattern.test(src)) continue;

      try {
        const bonus = getCounterResistCharmBonus(frame.contentDocument);
        if (bonus > 0) return bonus;
      } catch (e) {
      }
    }

    if (lastHoveredEquipmentId === Number(eid)) {
      return getCounterResistCharmBonus(document.getElementById('popup_box'));
    }
    return 0;
  }

  function requestCounterResistCharmBonus(eid, onComplete, modifyFilter = '') {
    const equipmentId = Number(eid);
    if (!equipmentId) return;

    if (COUNTER_RESIST_CHARM_CACHE.has(equipmentId)) {
      const cachedValue = Number(COUNTER_RESIST_CHARM_CACHE.get(equipmentId));
      if (cachedValue > 0) {
        if (typeof onComplete === 'function') onComplete(cachedValue);
        return;
      }
      COUNTER_RESIST_CHARM_CACHE.delete(equipmentId);
    }

    if (COUNTER_RESIST_CHARM_STATUS.get(equipmentId) === 'empty') {
      if (typeof onComplete === 'function') onComplete(0);
      return;
    }

    const retryAt = Number(COUNTER_RESIST_CHARM_RETRY_AT.get(equipmentId) || 0);
    if (retryAt > Date.now()) {
      if (typeof onComplete === 'function') onComplete(0);
      return;
    }

    if (typeof onComplete === 'function') {
      const existing = COUNTER_RESIST_CHARM_REQUESTS.get(equipmentId);
      if (existing) {
        existing.callbacks.push(onComplete);
        return;
      }
    }

    const request = { callbacks: typeof onComplete === 'function' ? [onComplete] : [] };
    COUNTER_RESIST_CHARM_REQUESTS.set(equipmentId, request);
    COUNTER_RESIST_CHARM_STATUS.set(equipmentId, 'pending');
    const charmRequestUrl = new URL(
      `?s=Bazaar&ss=am&screen=modify&eqids=${equipmentId}`,
      location.href
    ).href;

    let settled = false;
    const finish = (bonus, cacheResult = true, resultStatus = '') => {
      if (settled) return;
      settled = true;
      const value = Number.isFinite(Number(bonus)) && Number(bonus) > 0 ? Number(bonus) : 0;
      if (value > 0) {
        COUNTER_RESIST_CHARM_CACHE.set(equipmentId, value);
        COUNTER_RESIST_CHARM_STATUS.set(equipmentId, 'success');
        COUNTER_RESIST_CHARM_RETRY_AT.delete(equipmentId);
        persistCounterResistCharmCache();
      } else if (cacheResult && resultStatus === 'empty') {
        COUNTER_RESIST_CHARM_CACHE.delete(equipmentId);
        COUNTER_RESIST_CHARM_STATUS.set(equipmentId, 'empty');
        COUNTER_RESIST_CHARM_RETRY_AT.delete(equipmentId);
      } else {
        COUNTER_RESIST_CHARM_CACHE.delete(equipmentId);
        COUNTER_RESIST_CHARM_STATUS.set(equipmentId, 'error');
        COUNTER_RESIST_CHARM_RETRY_AT.set(equipmentId, Date.now() + 5000);
      }
      COUNTER_RESIST_CHARM_REQUESTS.delete(equipmentId);
      const callbacks = request.callbacks.slice();
      request.callbacks.length = 0;
      callbacks.forEach(callback => {
        try {
          callback(value);
        } catch (e) {}
      });
    };

    const parseCharmResponse = html => {
      try {
        const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
        const parsedBonus = getCounterResistCharmBonus(doc);
        return parsedBonus > 0 ? parsedBonus : getCounterResistCharmBonusFromHtml(html);
      } catch (e) {
        return getCounterResistCharmBonusFromHtml(html);
      }
    };

    const isCharmModifyPage = html => {
      try {
        const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
        return Boolean(doc.querySelector('.eqcharm'));
      } catch (e) {
        return /class=["'][^"']*\beqcharm\b/i.test(String(html || ''));
            }
        };

        const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : null;
        const pageDocument = pageWindow?.document || document;
        const pageFetch = pageWindow && typeof pageWindow.fetch === 'function'
            ? pageWindow.fetch.bind(pageWindow)
            : null;
        const pageXHR = pageWindow && typeof pageWindow.XMLHttpRequest === 'function'
            ? pageWindow.XMLHttpRequest
            : null;
        let pageFetchAttempts = 0;
        const maxPageFetchAttempts = 2;
        let pageXHRAttempts = 0;
        let pageBridgeAttempts = 0;

        let attempts = 0;
        const maxAttempts = 3;
        const retryDelay = 1000;
        const enqueueRequest = () => {
            if (settled) return;
            enqueueCounterResistCharmAjax(release => {
                let released = false;
                const releaseOnce = () => {
                    if (released) return;
                    released = true;
                    release();
                };
                const retry = () => {
                    releaseOnce();
                    if (settled || attempts >= maxAttempts) {
                        finish(0, false);
                        return;
                    }
                    window.setTimeout(enqueueRequest, retryDelay);
                };

                attempts++;
                try {
                    GM_xmlhttpRequest({
                        method: 'GET',
                        url: charmRequestUrl,
                        onload: response => {
                            const responseText = String(response?.responseText || '');
                            if (/state lock limiter in effect/i.test(responseText)) {
                                retry();
                                return;
                            }
                            releaseOnce();
                            if (response?.status === 200) {
                                const bonus = parseCharmResponse(responseText);
                                if (bonus > 0) {
                                    finish(bonus, true, 'success');
                                } else if (isCharmModifyPage(responseText)) {
                                    if (!requestWithCharmIframe()) finish(0, true, 'empty');
                                } else if (!requestWithCharmIframe()) {
                                    finish(0, false);
                                }
                            } else if (!requestWithCharmIframe()) {
                                finish(0, false);
                            }
                        },
                        onerror: () => {
                            releaseOnce();
                            if (!requestWithCharmIframe()) finish(0, false);
                        },
                        ontimeout: () => {
                            releaseOnce();
                            if (!requestWithCharmIframe()) finish(0, false);
                        },
                        timeout: 10000,
                    });
                } catch (e) {
                    releaseOnce();
                    if (!requestWithCharmIframe()) finish(0, false);
                }
            });
        };

        let iframeAttempts = 0;
        const requestWithCharmIframe = () => {
            if (settled || iframeAttempts >= 1 || !pageDocument?.body) {
                return false;
            }
            iframeAttempts++;

            const frame = pageDocument.createElement('iframe');
            frame.setAttribute('aria-hidden', 'true');
            frame.style.cssText = 'display:none !important; width:0; height:0; border:0;';
            let timer = null;
            let poller = null;
            let cleaned = false;

            const cleanup = () => {
                if (cleaned) return;
                cleaned = true;
                if (timer !== null) window.clearTimeout(timer);
                if (poller !== null) window.clearInterval(poller);
                frame.remove();
            };
            const fallback = () => {
                cleanup();
                if (typeof GM_xmlhttpRequest === 'function') {
                    enqueueRequest();
                } else {
                    finish(0, false);
                }
            };
            const inspect = () => {
                if (settled || cleaned) return;
                let doc = null;
                try {
                    doc = frame.contentDocument;
                } catch (e) {
                    fallback();
                    return;
                }
                if (!doc) return;
                const bodyText = String(doc?.body?.textContent || '');
                if (/state lock limiter in effect/i.test(bodyText)) {
                    fallback();
                    return;
                }
                const charmPage = Boolean(doc?.querySelector?.('.eqcharm'));
                if (!charmPage) return;
                const bonus = getCounterResistCharmBonus(doc);
                cleanup();
                finish(bonus, true, bonus > 0 ? 'success' : 'empty');
            };

            frame.addEventListener('load', inspect);
            pageDocument.body.appendChild(frame);
            frame.src = charmRequestUrl;
            poller = window.setInterval(inspect, 200);
            timer = window.setTimeout(fallback, 12000);
            return true;
        };

        const requestWithPageBridge = () => {
            if (settled || pageBridgeAttempts >= 1 || !pageDocument?.documentElement) return false;
            pageBridgeAttempts++;

            const token = `hv-charm-${equipmentId}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
            const messageTarget = pageWindow || window;
            let timer = null;
            let cleaned = false;

            const cleanup = () => {
                if (cleaned) return;
                cleaned = true;
                if (timer !== null) window.clearTimeout(timer);
                try {
                    messageTarget.removeEventListener('message', onMessage, true);
                } catch (e) {}
                try {
                    script.remove();
                } catch (e) {
                    try {
                        script.parentNode?.removeChild(script);
                    } catch (e2) {}
                }
            };
            const fallback = () => {
                cleanup();
                if (!requestWithPageXHR() && !requestWithCharmIframe() && !requestWithPageFetch()) {
                    enqueueRequest();
                }
            };
            const onMessage = event => {
                const data = event?.data;
                if (!data || data.type !== 'HV_CHARM_PAGE_RESULT' || data.token !== token) return;
                const status = Number(data.status);
                const bonus = Number(data.bonus);
                try {
                    if (status === 200 && Number.isFinite(bonus) && bonus > 0) {
                        finish(bonus, true, 'success');
                    } else if (status === 200 && data.hasCharmPage) {
                        finish(0, true, 'empty');
                    } else {
                        fallback();
                    }
                } finally {
                    cleanup();
                }
            };
            const script = pageDocument.createElement('script');
            const serializedUrl = JSON.stringify(charmRequestUrl);
            const serializedToken = JSON.stringify(token);
            script.textContent = `(()=>{
                const token=${serializedToken};
                const send=(data)=>window.postMessage({type:'HV_CHARM_PAGE_RESULT',token,...data},'*');
                try{
                    const xhr=new XMLHttpRequest();
                    xhr.open('GET',${serializedUrl},true);
                    xhr.withCredentials=true;
                    xhr.onload=()=>{
                        try{
                            const html=String(xhr.responseText||'');
                            const doc=new DOMParser().parseFromString(html,'text/html');
                            const nodes=Array.from(doc.querySelectorAll('.eqcharm th'));
                            const containers=Array.from(doc.querySelectorAll('.eqcharm, .chm'));
                            const names=nodes.length?nodes.map(node=>String(node.textContent||'').trim()):containers.map(node=>String(node.textContent||'').trim());
                            let bonus=0;
                            for(const name of names){
                                const compact=String(name||'').replace(/[\\s\\u200B-\\u200D\\uFEFF]/g,'');
                                const isCounter=/(?:counter[- ]*resist|反抵抗率|反抵抗|penetrator)/i.test(name)||compact.includes('反抵抗率')||compact.includes('反抵抗')||compact.toLowerCase().includes('penetrator');
                                if(!isCounter)continue;
                                if(/(?:greater|major|large|\\(\\s*g\\s*\\)|\\uFF08\\s*大(?:型)?\\s*\\uFF09|大型|大护符)/i.test(name)||/(?:greater|major|large|大(?:型)?)/i.test(compact))bonus+=20;
                                else if(/(?:lesser|minor|small|\\(\\s*l\\s*\\)|\\uFF08\\s*小(?:型)?\\s*\\uFF09|小型|小护符)/i.test(name)||/(?:lesser|minor|small|小(?:型)?)/i.test(compact))bonus+=12;
                            }
                            send({status:xhr.status,bonus,hasCharmPage:Boolean(doc.querySelector('.eqcharm'))});
                        }catch(error){send({status:xhr.status,bonus:0,hasCharmPage:false});}
                    };
                    xhr.onerror=()=>send({status:0,bonus:0,hasCharmPage:false});
                    xhr.send();
                }catch(error){send({status:0,bonus:0,hasCharmPage:false});}
            })();`;
            messageTarget.addEventListener('message', onMessage, true);
            pageDocument.documentElement.appendChild(script);
            timer = window.setTimeout(fallback, 10000);
            return true;
        };

        const requestWithPageXHR = () => {
            if (settled || !pageXHR || pageXHRAttempts >= 2) return false;
            pageXHRAttempts++;
            let xhr = null;
            try {
                xhr = new pageXHR();
                xhr.open('GET', charmRequestUrl, true);
                xhr.withCredentials = true;
                xhr.onload = () => {
                    if (settled) return;
                    const responseText = String(xhr.responseText || '');
                    if (/state lock limiter in effect/i.test(responseText)) {
                        if (!requestWithPageXHR() && !requestWithCharmIframe()) enqueueRequest();
                        return;
                    }
                    if (xhr.status === 200) {
                        const bonus = parseCharmResponse(responseText);
                        if (bonus > 0) {
                            finish(bonus, true, 'success');
                            return;
                        }
                        if (isCharmModifyPage(responseText)) {
                            if (!requestWithCharmIframe()) finish(0, true, 'empty');
                            return;
                        }
                    }
                    if (!requestWithCharmIframe() && !requestWithPageFetch()) enqueueRequest();
                };
                xhr.onerror = () => {
                    if (!requestWithPageXHR() && !requestWithCharmIframe()) enqueueRequest();
                };
                xhr.ontimeout = xhr.onerror;
                xhr.timeout = 10000;
                xhr.send();
            } catch (e) {
                if (!requestWithCharmIframe()) return false;
            }
            return true;
        };

        const requestWithPageFetch = () => {
            if (settled || !pageFetch || pageFetchAttempts >= maxPageFetchAttempts) return false;
            pageFetchAttempts++;
            let pageRequest;
            try {
                pageRequest = pageFetch(charmRequestUrl, {
                    credentials: 'include',
                    cache: 'no-store',
                });
            } catch (e) {
                return false;
            }

            Promise.resolve(pageRequest)
                .then(response => Promise.resolve(response.text()).then(responseText => ({ response, responseText })))
                .then(({ response, responseText }) => {
                    if (settled) return;
                    if (/state lock limiter in effect/i.test(String(responseText || '')) &&
                        pageFetchAttempts < maxPageFetchAttempts) {
                        window.setTimeout(requestWithPageFetch, retryDelay);
                        return;
                    }
                    if (response?.status === 200) {
                        const bonus = parseCharmResponse(responseText);
                        if (bonus > 0) {
                            finish(bonus, true, 'success');
                            return;
                        }
                        if (isCharmModifyPage(responseText)) {
                            if (!requestWithCharmIframe()) finish(0, true, 'empty');
                            return;
                        }
                    }
                    if (!requestWithCharmIframe() && !requestWithPageFetch()) enqueueRequest();
                })
                .catch(() => {
                    if (!requestWithCharmIframe() && !requestWithPageFetch()) enqueueRequest();
                });
            return true;
        };

        if (!requestWithPageBridge() && !requestWithPageXHR() && !requestWithCharmIframe() && !requestWithPageFetch()) {
            if (typeof GM_xmlhttpRequest === 'function') {
                enqueueRequest();
            } else {
                finish(0, false);
            }
        }
    }

    function persistCharmInfoCache() {
        if (typeof GM_setValue !== 'function') return;
        try {
            GM_setValue(CHARM_INFO_STORAGE_KEY, JSON.stringify(
                Object.fromEntries(
                    Array.from(CHARM_INFO_CACHE.entries())
                        .filter(([, info]) => Array.isArray(info))
                        .map(([eid, info]) => [String(eid), {
                            at: Number(CHARM_INFO_CACHE_AT.get(Number(eid))) || Date.now(),
                            charms: info.map(charm => ({ type: charm.type, size: charm.size })),
                        }])
                )
            ));
        } catch (e) {}
    }

    function isCharmInfoFresh(equipmentId) {
        const at = Number(CHARM_INFO_CACHE_AT.get(Number(equipmentId)) || 0);
        return at > 0 && Date.now() - at < CHARM_INFO_CACHE_TTL;
    }

    try {
        const storedCharmInfo = typeof GM_getValue === 'function'
            ? GM_getValue(CHARM_INFO_STORAGE_KEY, '')
            : '';
        const parsedCharmInfo = typeof storedCharmInfo === 'string'
            ? JSON.parse(storedCharmInfo || '{}')
            : storedCharmInfo;
        if (parsedCharmInfo && typeof parsedCharmInfo === 'object') {
            Object.entries(parsedCharmInfo).forEach(([eid, stored]) => {
                const equipmentId = Number(eid);
                const rawInfo = stored && !Array.isArray(stored) && Array.isArray(stored.charms)
                    ? stored.charms
                    : (Array.isArray(stored) ? stored : null);
                if (equipmentId > 0 && rawInfo) {
                    const charms = [];
                    const seenTypes = new Set();
                    rawInfo.forEach(charm => {
                        if (charm && CHARM_DEFS[charm.type] &&
                            (charm.size === 'lesser' || charm.size === 'greater') &&
                            !seenTypes.has(charm.type)) {
                            seenTypes.add(charm.type);
                            charms.push({ type: charm.type, size: charm.size });
                        }
                    });
                    CHARM_INFO_CACHE.set(equipmentId, charms);
                    CHARM_INFO_CACHE_AT.set(equipmentId, Number(stored?.at) || 0);
                }
            });
        }
    } catch (e) {}

    function requestEquipmentCharmInfo(eid, onComplete, force) {
        const equipmentId = Number(eid);
        if (!equipmentId) {
            if (typeof onComplete === 'function') onComplete(null);
            return;
        }
        if (!force && CHARM_INFO_CACHE.has(equipmentId) && isCharmInfoFresh(equipmentId)) {
            if (typeof onComplete === 'function') onComplete(CHARM_INFO_CACHE.get(equipmentId) || null);
            return;
        }
        if (!force && CHARM_INFO_STATUS.get(equipmentId) === 'empty' && !CHARM_INFO_CACHE.has(equipmentId)) {
            if (typeof onComplete === 'function') onComplete(null);
            return;
        }
        const retryAt = Number(CHARM_INFO_RETRY_AT.get(equipmentId) || 0);
        if (!force && retryAt > Date.now()) {
            if (typeof onComplete === 'function') onComplete(null);
            return;
        }
        if (typeof onComplete === 'function') {
            const existing = CHARM_INFO_REQUESTS.get(equipmentId);
            if (existing) {
                existing.push(onComplete);
                return;
            }
        }
        const request = { callbacks: typeof onComplete === 'function' ? [onComplete] : [] };
        CHARM_INFO_REQUESTS.set(equipmentId, request);
        CHARM_INFO_STATUS.set(equipmentId, 'pending');
        const charmInfoUrl = new URL(
            '?s=Bazaar&ss=am&screen=modify&eqids=' + equipmentId,
            location.href
        ).href;
        let settled = false;
        let attempts = 0;
        const finish = (info, cacheResult = true, resultStatus = 'success') => {
            if (settled) return;
            settled = true;
            const parsedInfo = Array.isArray(info)
                ? info
                    .map(charm => charm && CHARM_DEFS[charm.type] &&
                        (charm.size === 'lesser' || charm.size === 'greater')
                        ? { type: charm.type, size: charm.size }
                        : null)
                    .filter(Boolean)
                : [];
            const uniqueInfo = [];
            const seenTypes = new Set();
            parsedInfo.forEach(charm => {
                if (!seenTypes.has(charm.type)) {
                    seenTypes.add(charm.type);
                    uniqueInfo.push(charm);
                }
            });
            if (cacheResult) {
                CHARM_INFO_CACHE.set(equipmentId, uniqueInfo);
                CHARM_INFO_CACHE_AT.set(equipmentId, Date.now());
                CHARM_INFO_STATUS.set(equipmentId, resultStatus || 'success');
                CHARM_INFO_RETRY_AT.delete(equipmentId);
                persistCharmInfoCache();
            } else {
                CHARM_INFO_CACHE.delete(equipmentId);
                CHARM_INFO_STATUS.set(equipmentId, 'error');
                CHARM_INFO_RETRY_AT.set(equipmentId, Date.now() + 5000);
            }
            CHARM_INFO_REQUESTS.delete(equipmentId);
            const callbacks = request.callbacks.slice();
            request.callbacks.length = 0;
            callbacks.forEach(callback => {
                try {
                    callback(parsedInfo);
                } catch (e) {}
            });
        };
        const enqueue = () => {
            if (settled) return;
            enqueueCounterResistCharmAjax(release => {
                let released = false;
                const releaseOnce = () => {
                    if (released) return;
                    released = true;
                    release();
                };
                attempts++;
                try {
                    GM_xmlhttpRequest({
                        method: 'GET',
                        url: charmInfoUrl,
                        onload: response => {
                            const responseText = String(response?.responseText || '');
                            if (/state lock limiter in effect/i.test(responseText)) {
                                releaseOnce();
                                if (attempts < 3) window.setTimeout(enqueue, 1000);
                                else finish(null, false);
                                return;
                            }
                            releaseOnce();
                            if (response?.status === 200) {
                                try {
                                    const doc = new DOMParser().parseFromString(responseText, 'text/html');
                                    if (doc.querySelector('.eqcharm')) {
                                        const info = getEquipmentCharmInfoFromDoc(doc);
                                        const crBonus = getCounterResistCharmBonus(doc);
                                        if (crBonus > 0) {
                                            COUNTER_RESIST_CHARM_CACHE.set(equipmentId, crBonus);
                                            persistCounterResistCharmCache();
                                        } else if (COUNTER_RESIST_CHARM_CACHE.has(equipmentId)) {
                                            COUNTER_RESIST_CHARM_CACHE.delete(equipmentId);
                                            persistCounterResistCharmCache();
                                        }
                                        finish(info, true, info && info.length ? 'success' : 'empty');
                                        return;
                                    }
                                } catch (e) {}
                            }
                            if (attempts < 3) window.setTimeout(enqueue, 1000);
                            else finish(null, false);
                        },
                        onerror: () => {
                            releaseOnce();
                            if (attempts < 3) window.setTimeout(enqueue, 1000);
                            else finish(null, false);
                        },
                        ontimeout: () => {
                            releaseOnce();
                            if (attempts < 3) window.setTimeout(enqueue, 1000);
                            else finish(null, false);
                        },
                        timeout: 10000,
                    });
                } catch (e) {
                    releaseOnce();
                    if (attempts < 3) window.setTimeout(enqueue, 1000);
                    else finish(null, false);
                }
            });
        };
        enqueue();
    }

    function waitForEquipmentCharmInfo(eid, force) {
        const equipmentId = Number(eid);
        if (!equipmentId) return Promise.resolve(null);
        if (!force && CHARM_INFO_CACHE.has(equipmentId) && isCharmInfoFresh(equipmentId)) {
            return Promise.resolve(CHARM_INFO_CACHE.get(equipmentId) || null);
        }
        return new Promise(resolve => {
            requestEquipmentCharmInfo(equipmentId, resolve, force);
        });
    }

    async function waitForEquipmentCharmData(equipSlots, force) {
        const pending = [];
        (equipSlots || []).forEach((slot, index) => {
            const slotId = Number(slot?.slotId);
            const isHand = slotId === 1 || slotId === 2 || (slot?.slotId == null && index < 2);
            if (!isHand || !slot?.available || !slot?.eid) return;
            pending.push(
                waitForEquipmentCharmInfo(slot.eid, force).then(info => ({ slot, info }))
            );
        });
        const results = await Promise.all(pending);
        results.forEach(({ slot, info }) => {
            if (!slot) return;
            const equipmentId = Number(slot.eid);
            slot.counterResistCharmDataPending = false;
            const charms = Array.isArray(info) ? info : [];
            if (charms.length) {
                CHARM_INFO_CACHE.set(equipmentId, charms);
                persistCharmInfoCache();
            }
            slot.actualCharms = charms;
            const crCharm = charms.find(charm => charm?.type === 'penetrator');
            const bonus = crCharm
                ? (crCharm.size === 'greater' ? COUNTER_RESIST_CHARM_BONUS.greater : COUNTER_RESIST_CHARM_BONUS.lesser)
                : 0;
            if (Number(bonus) > 0) {
                slot.counterResistCharmBonus = Number(bonus);
                normalizeCounterResistCharmData(slot, Number(bonus));
                COUNTER_RESIST_CHARM_CACHE.set(equipmentId, Number(bonus));
                persistCounterResistCharmCache();
            } else {
                slot.counterResistCharmBonus = 0;
                if (COUNTER_RESIST_CHARM_CACHE.has(equipmentId)) {
                    COUNTER_RESIST_CHARM_CACHE.delete(equipmentId);
                    persistCounterResistCharmCache();
                }
            }
        });
        if (activeUpgradeSimulation?.refreshEquipmentData) {
            activeUpgradeSimulation.refreshEquipmentData();
        }
        return equipSlots;
    }
    function normalizeCounterResistCharmData(slot, bonus) {
        const charmBonus = Number(bonus);
        if (!slot || !Number.isFinite(charmBonus) || charmBonus <= 0) return slot;

        slot.counterResistCharmBonus = charmBonus;
        slot.counterResistCharmDataPending = false;

        const stats = Array.isArray(slot.stats) ? slot.stats : (slot.stats = []);
        const equipmentStat = stats.find(stat =>
            stat && isCounterResistTitle(stat.title) && stat.source !== 'charm'
        );

        let charmStat = stats.find(stat =>
            stat && stat.source === 'charm' && isCounterResistTitle(stat.title)
        );
        let inlineCharm = false;

        if (equipmentStat) {
            const split = splitCounterResistCharmValue(equipmentStat, charmBonus);
            if (split.includesCharm || split.charmOnly) {
                const equipmentValue = split.equipmentValue;
                if (split.charmOnly) {
                    equipmentStat.source = 'charm';
                    equipmentStat.scalesWithUpgrade = false;
                    equipmentStat.val = charmBonus;
                    equipmentStat.baseValue = charmBonus;
                    inlineCharm = true;
                    slot.counterResistValue = 0;
                } else {
                    equipmentStat.source = 'equipment';
                    equipmentStat.val = equipmentValue;
                    const initialLevel = Number(slot.forge || 0) + Number(slot.iw || 0);
                    const rate = Number.isFinite(Number(equipmentStat.rate))
                        ? Number(equipmentStat.rate)
                        : 1;
                    equipmentStat.baseValue = equipmentValue / (1 + initialLevel * rate / 100);
                    slot.counterResistValue = equipmentValue;
                }
            } else if (!Number.isFinite(Number(slot.counterResistValue))) {
                slot.counterResistValue = Number(equipmentStat.val);
            }
        } else if (Number.isFinite(Number(slot.counterResistValue))) {
            const split = splitCounterResistCharmValue({
                val: Number(slot.counterResistValue),
                scalesWithUpgrade: slot.counterResistScalesWithUpgrade !== false,
                source: 'equipment',
            }, charmBonus);
            if (split.charmOnly) {
                slot.counterResistValue = 0;
                inlineCharm = true;
            } else if (split.includesCharm) {
                slot.counterResistValue = split.equipmentValue;
            }
        }

        const charmStats = stats.filter(stat =>
            stat && stat.source === 'charm' && isCounterResistTitle(stat.title)
        );
        if (!inlineCharm) {
            charmStat = charmStat || charmStats[0];
            if (!charmStat) {
                charmStat = {
                    title: 'Counter-resist',
                    val: charmBonus,
                    rate: 1,
                    section: 'ex',
                    scalesWithUpgrade: false,
                    source: 'charm',
                    baseValue: charmBonus,
                };
                stats.push(charmStat);
            } else {
                charmStat.val = charmBonus;
                charmStat.rate = 1;
                charmStat.scalesWithUpgrade = false;
                charmStat.baseValue = charmBonus;
            }
        }

        if (charmStats.length > 1 || (inlineCharm && charmStats.length > 0)) {
            const keep = inlineCharm ? (equipmentStat || charmStats[0]) : charmStat;
            for (let i = stats.length - 1; i >= 0; i--) {
                const stat = stats[i];
                if (stat && stat !== keep && stat.source === 'charm' && isCounterResistTitle(stat.title)) {
                    stats.splice(i, 1);
                }
            }
        }

        return slot;
    }

    function parseStatsFromHtml(html) {
        const stats = [];
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const eq = doc.querySelector('.eq');
        let eqt = '';
        const counterResistCharmBonus = getCounterResistCharmBonus(doc);
        if (!eq) return { stats, eqt, counterResistCharmBonus };

        const eqtDiv = eq.querySelector('.eqt');
        if (eqtDiv) eqt = eqtDiv.textContent.trim();

        let currentSection = 'ex';
        const regexVal = /^([+-]?\d+(?:\.\d+)?)(?:\s+(\S.*))?$/;
        const regexDamage = /^(?:Magic|Attack|Void|Crushing|Piercing|Slashing) Damage/;

        function addStat(node, section, nameNode, valueSpan) {
            if (!valueSpan) return;
            const match = regexVal.exec(valueSpan.textContent.trim());
            if (!match) return;
            const name = match[2] || nameNode?.textContent.trim() || '';
            if (!name) return;
            const value = parseFloat(match[1]);
            if (!Number.isFinite(value)) return;
            const baseMatch = (node.getAttribute('title') || '').match(/Base:\s*([+-]?[\d.]+)/i);
            const isCharmNode = Boolean(node.closest?.('.chm'));
            stats.push({
                title: name,
                val: value,
                rate: regexDamage.test(name) ? 2 : 1,
                section,
                scalesWithUpgrade: !isCharmNode && (Boolean(baseMatch) || section === 'proficiency'),
                source: isCharmNode ? 'charm' : 'equipment',
            });
        }

        function addDirectStats(parent, section) {
            for (const node of parent.children) {
                const children = node.children;
                if (children.length < 2) continue;
                const valueSpan = children[1].querySelector('span');
                addStat(node, section, children[0], valueSpan);
            }
        }

        for (const child of eq.children) {
            if (child.classList && child.classList.contains('ex')) {
                addDirectStats(child, 'ex');
                continue;
            }

            if (child.classList && child.classList.contains('ep')) {
                let sectionType = currentSection;
                for (const node of child.children) {
                    if (!node.querySelector('span')) {
                        const text = node.textContent.trim();
                        if (text.includes('Spell Damage')) {
                            sectionType = 'spell';
                        } else if (text.includes('Damage Mitigation')) {
                            sectionType = 'mitigation';
                        } else if (text.includes('Primary Attributes')) {
                            sectionType = 'primary';
                        } else if (text.includes('Proficiency')) {
                            sectionType = 'proficiency';
                        }
                        continue;
                    }
                    const children = node.children;
                    if (children.length < 2) continue;
                    const valueSpan = children[1].querySelector('span');
                    addStat(node, sectionType, children[0], valueSpan);
                }
                currentSection = sectionType;
                continue;
            }

            if (child.hasAttribute && child.hasAttribute('title') && child.getAttribute('title').includes('Base:')) {
                addStat(child, 'ex', child.firstElementChild, child.querySelector('span'));
            }
        }

        return { stats, eqt, counterResistCharmBonus };
    }

    const EQUIPMENT_DETAIL_CACHE = new Map();

    function getParsedEquipmentDetail(eid, detail) {
        const html = detail?.d || '';
        const cached = EQUIPMENT_DETAIL_CACHE.get(eid);
        if (cached && cached.html === html) return cached;

        const tierMatch = /Tier\s+(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)/i.exec(html);
        const parsed = parseStatsFromHtml(html);
        const hasCounterResist = parsed.stats.some(stat => /(?:counter[- ]?resist)/i.test(stat.title));
        const counterResistMatch = html.match(/(?:Counter-resist|Counter Resist)\D*([+-]?\d+(?:\.\d+)?)/i);
        if (!hasCounterResist && counterResistMatch) {
            const counterResist = parseFloat(counterResistMatch[1]);
            if (Number.isFinite(counterResist)) {
                parsed.stats.push({
                    title: 'Counter-resist',
                    val: counterResist,
                    rate: 1,
                    section: 'ex',
                    scalesWithUpgrade: false,
                });
            }
        }
        const counterResistStat = parsed.stats.find(stat => isCounterResistTitle(stat.title));
        const result = {
            html,
            forge: tierMatch ? parseInt(tierMatch[1], 10) : 0,
            iw: tierMatch ? parseInt(tierMatch[2], 10) : 0,
            max: tierMatch ? parseInt(tierMatch[3], 10) : 0,
            stats: parsed.stats,
            weaponType: parsed.eqt,
            counterResistValue: counterResistStat && Number.isFinite(Number(counterResistStat.val))
                ? Number(counterResistStat.val)
                : null,
            counterResistRate: counterResistStat && Number.isFinite(Number(counterResistStat.rate))
                ? Number(counterResistStat.rate)
                : 1,
            counterResistScalesWithUpgrade: counterResistStat
                ? counterResistStat.scalesWithUpgrade !== false
                : false,
            counterResistCharmBonus: parsed.counterResistCharmBonus || 0,
        };
        EQUIPMENT_DETAIL_CACHE.set(eid, result);
        return result;
    }

    const FIXED_EQUIP_SLOT_LABELS = Object.freeze({
        1: '主手',
        2: '副手',
        11: '身体',
        12: '腿部',
        13: '头盔',
        14: '手部',
        15: '足部',
    });
    const FIXED_EQUIP_SLOT_ORDER = Object.freeze([1, 2, 13, 11, 14, 12, 15]);

    function normalizeUnavailableReason(reason) {
        const text = String(reason || '').trim();
        if (!text) return '';
        const compact = text.replace(/[()\s-]/g, '').toLowerCase();
        if (compact === 'unavailablewithcurrentmainhand') return '当前主手无法搭配副手装备';
        if (compact === 'empty') return '空';
        return text;
    }

    function getEquipmentSlotId(eqb) {
        const onclick = eqb.getAttribute('onclick') || '';
        const match = onclick.match(/[?&]equip_slot=(\d+)/i);
        return match ? parseInt(match[1], 10) : null;
    }

    function getEquipmentData() {
        const slots = [];
        const eqbList = document.querySelectorAll('#eqsb .eqb');
        eqbList.forEach((eqb, index) => {
            let slotId = getEquipmentSlotId(eqb);
            if (slotId === null && index < FIXED_EQUIP_SLOT_ORDER.length) {
                slotId = FIXED_EQUIP_SLOT_ORDER[index];
            }
            const slotName = FIXED_EQUIP_SLOT_LABELS[slotId] || `槽位${index+1}`;
            const stateIndex = slotId !== null ? slotId : `dom-${index}`;
            const infoSpan = eqb.querySelector('.hvut-eq-info span');
            const equipDiv = eqb.querySelector('[data-eid]') || eqb.querySelector('[onmouseover*="equips.set"]');
            const eqempty = eqb.querySelector('.eqempty');
            const isDisabled = eqb.classList.contains('eqdisabled');
            const hasEquip = equipDiv !== null;
            const available = !isDisabled && hasEquip;

            let unavailableReason = '';
            if (isDisabled && eqempty) {
                unavailableReason = normalizeUnavailableReason(eqempty.textContent);
            } else if (!hasEquip) {
                unavailableReason = normalizeUnavailableReason(eqempty ? eqempty.textContent : '') || '空';
            }

            let eid = equipDiv ? parseInt(equipDiv.dataset.eid, 10) : null;
            if (!Number.isFinite(eid) && equipDiv) {
                const hoverMatch = (equipDiv.getAttribute('onmouseover') || '').match(/equips\.set\((\d+)/);
                if (hoverMatch) eid = parseInt(hoverMatch[1], 10);
            }
            const name = equipDiv ? equipDiv.textContent.trim() : '';

            let displayForge = 0, displayIW = 0;
            if (infoSpan) {
                const parts = infoSpan.textContent.trim().split('/').map(s => parseInt(s.trim(), 10));
                if (parts.length === 2) {
                    displayForge = parts[0];
                    displayIW = parts[1];
                } else if (parts.length === 3) {
                    displayForge = parts[0];
                    displayIW = parts[1];
                }
            }

            let detail = null;
            let enName = '';
            let forge = 0, iw = 0, max = 0;
            let stats = [];
            let weaponType = '';
            let counterResistValue = null;
            let counterResistRate = 1;
            let counterResistCharmBonus = 0;
            let counterResistCharmDataPending = false;
            if (available && eid && typeof unsafeWindow !== 'undefined') {
                const dynjs = unsafeWindow.dynjs_equip || {};
                if (dynjs[eid]) {
                    detail = dynjs[eid];
                } else if (unsafeWindow.equips && typeof unsafeWindow.equips.get === 'function') {
                    try {
                        const eqObj = unsafeWindow.equips.get(eid);
                        if (eqObj && eqObj.d) detail = eqObj;
                    } catch(e) {}
                }
            }

            if (detail) {
                const parsed = getParsedEquipmentDetail(eid, detail);
                enName = String(detail.t || '').trim();
                forge = parsed.forge;
                iw = parsed.iw;
                max = parsed.max;
                stats = parsed.stats.map(stat => ({ ...stat }));
                weaponType = parsed.weaponType;
                counterResistValue = parsed.counterResistValue;
                counterResistRate = parsed.counterResistRate;
                counterResistCharmBonus = parsed.counterResistCharmBonus || 0;
            }

            if (counterResistCharmBonus <= 0 && available && eid) {
                const visibleCharmBonus = getCounterResistCharmBonusForEquipment(eid);
                if (visibleCharmBonus > 0) {
                    counterResistCharmBonus = visibleCharmBonus;
                    COUNTER_RESIST_CHARM_CACHE.set(eid, visibleCharmBonus);
                } else if (slotId === 1 || slotId === 2 || (slotId === null && index < 2)) {
                    const cachedCharmBonus = COUNTER_RESIST_CHARM_CACHE.get(eid);
                    if (cachedCharmBonus !== undefined) {
                        if (cachedCharmBonus > 0) counterResistCharmBonus = cachedCharmBonus;
                    } else if (COUNTER_RESIST_CHARM_STATUS.get(eid) !== 'empty') {
                        counterResistCharmDataPending = true;
                        const modifyFilter = getEquipmentModifyFilter(enName, weaponType);
                        requestCounterResistCharmBonus(eid, bonus => {
                            if (bonus > 0 && activeUpgradeSimulation) {
                                const activeSlot = (activeUpgradeSimulation.equipSlots || [])
                                    .find(candidate => Number(candidate?.eid) === Number(eid));
                                if (activeSlot) normalizeCounterResistCharmData(activeSlot, bonus);
                                if (activeUpgradeSimulation.refreshEquipmentData) {
                                    activeUpgradeSimulation.refreshEquipmentData();
                                }
                            }
                            window.setTimeout(() => notifyMaccSimulationChanged(), 0);
                        }, modifyFilter);
                    }
                }
            }

            if (forge === 0 && displayForge !== 0) forge = displayForge;
            if (iw === 0 && displayIW !== 0) iw = displayIW;

            const classQuality = equipDiv?.className?.match(/hvut-equip-(Superior|Exquisite|Magnificent|Legendary|Peerless|Ultimate)/i)?.[1];
            const quality = getQualityFromCode(detail?.q)
                || extractQualityFromName(enName)
                || classQuality
                || extractQualityFromName(name)
                || '';
            const cap = getQualityCap(quality);
            if (max === 0) max = cap;

            if (counterResistCharmBonus > 0) {
                const normalizedSlot = {
                    stats,
                    forge,
                    iw,
                    counterResistValue,
                    counterResistScalesWithUpgrade: true,
                };
                normalizeCounterResistCharmData(normalizedSlot, counterResistCharmBonus);
                counterResistValue = normalizedSlot.counterResistValue;
                const normalizedCounterStat = stats.find(stat =>
                    stat && isCounterResistTitle(stat.title) && stat.source !== 'charm'
                );
                if (normalizedCounterStat) {
                    counterResistValue = Number.isFinite(Number(normalizedCounterStat.val))
                        ? Number(normalizedCounterStat.val)
                        : counterResistValue;
                }
            }

            const initialTotalLevel = forge + iw;
            for (const stat of stats) {
                const denominator = 1 + initialTotalLevel * stat.rate / 100;
                const value = Number(stat.val);
                const baseValue = initialTotalLevel === 0 ? value : value / denominator;
                stat.baseValue = Number.isFinite(baseValue) ? baseValue : 0;
            }

            const slotCounterResistStat = stats.find(stat => isCounterResistTitle(stat.title));
            slots.push({
                index: stateIndex,
                slotId,
                eid,
                slotName,
                name,
                enName,
                forge,
                iw,
                max,
                quality,
                stats,
                weaponType,
                counterResistValue,
                counterResistRate,
                counterResistScalesWithUpgrade: slotCounterResistStat
                    ? slotCounterResistStat.scalesWithUpgrade !== false
                    : false,
                counterResistCharmBonus,
                counterResistCharmDataPending,
                charmInfo: eid && CHARM_INFO_CACHE.has(eid) ? CHARM_INFO_CACHE.get(eid) || null : null,
                available,
                unavailableReason,
            });
        });
        const orderedSlots = [];
        const fixedSlotById = new Map();
        slots.forEach(slot => {
            if (FIXED_EQUIP_SLOT_ORDER.includes(Number(slot.slotId))) {
                fixedSlotById.set(Number(slot.slotId), slot);
            } else {
                orderedSlots.push(slot);
            }
        });
        FIXED_EQUIP_SLOT_ORDER.forEach(slotId => {
            const slot = fixedSlotById.get(slotId);
            if (slot) orderedSlots.push(slot);
        });
        return orderedSlots;
    }

    function calculateTotalStats(equipSlots, levelMap) {
        const total = {};
        const damageTypes = ['Crushing Damage', 'Slashing Damage', 'Piercing Damage', 'Void Damage'];
        let attackDamageTotal = 0;

        (equipSlots || []).forEach((slot, index) => {
            if (!slot || !slot.available || !Array.isArray(slot.stats) || slot.stats.length === 0) return;
            const charms = getSlotAttackCharms(slot, index);
            for (const stat of slot.stats) {
                const current = stat?.source === 'charm'
                    ? (Number.isFinite(Number(stat.val)) ? Number(stat.val) : 0)
                    : getPureEquipmentStatValue(slot, stat.title, levelMap, charms);
                if (!Number.isFinite(current) || current <= 0) continue;
                const key = stat.title + '|' + stat.section;
                if (!total[key]) total[key] = 0;
                total[key] += current;

                if (stat.title === 'Attack Damage') {
                    attackDamageTotal += current;
                }
            }
            addAttackCharmContributions(total, slot, index, levelMap, charms);
        });

        if (attackDamageTotal > 0) {
            for (const dmg of damageTypes) {
                const key = dmg + '|ex';
                if (total[key] !== undefined) {
                    total[key] += attackDamageTotal;
                    break;
                }
            }
            for (const key of Object.keys(total)) {
                if (key.startsWith('Attack Damage|')) {
                    delete total[key];
                }
            }
        }

        for (const key of Object.keys(total)) {
            if (key.startsWith('Base Health') || key.startsWith('Base Mana') || key.startsWith('Base Spirit')) {
                total[key] = Math.floor(total[key]);
            }
        }

        return total;
    }
    function isCounterResistTitle(title) {
        return /(?:counter[\s-]*resist)/i.test(String(title || ''));
    }

    function splitCounterResistCharmValue(stat, charmBonus) {
        const rawValue = Number(stat?.val);
        const bonus = Number(charmBonus);
        if (!Number.isFinite(rawValue) || !(bonus > 0) || stat?.source === 'charm') {
            return {
                equipmentValue: rawValue,
                includesCharm: false,
                charmOnly: false,
            };
        }

        const epsilon = 0.0001;
        const includesCharm = rawValue > bonus + epsilon ||
            (stat.scalesWithUpgrade !== false && rawValue >= bonus - epsilon);
        const charmOnly = !includesCharm &&
            stat.scalesWithUpgrade === false &&
            Math.abs(rawValue - bonus) <= epsilon;

        return {
            equipmentValue: includesCharm || charmOnly
                ? Math.max(0, rawValue - bonus)
                : rawValue,
            includesCharm,
            charmOnly,
        };
    }

    function getCounterResistStatValue(stat, initialLevel, currentLevel) {
        if (!stat) return 0;

        const value = Number(stat.val);
        if (stat.scalesWithUpgrade === false) {
            return Number.isFinite(value) ? value : 0;
        }

        const rate = Number.isFinite(Number(stat.rate)) ? Number(stat.rate) : 1;
        const baseValue = Number.isFinite(Number(stat.baseValue))
            ? Number(stat.baseValue)
            : value / (1 + initialLevel * rate / 100);
        if (!Number.isFinite(baseValue)) return 0;
        return baseValue * (1 + currentLevel * rate / 100);
    }


    function resolveWeaponClass(slot) {
        if (!slot) return '';
        const parsed = normalizeCharmWeaponClass(slot.weaponType || '');
        if (parsed) return parsed;
        const filter = getEquipmentModifyFilter(slot.enName || slot.name || '', '');
        if (filter === 'weapon_staff') return 'staff';
        if (filter === 'weapon_onehand') return 'onehand';
        if (filter === 'weapon_twohand') return 'twohand';
        return '';
    }

    function getEquipmentStatForTitle(slot, title) {
        if (!slot || !Array.isArray(slot.stats)) return null;
        return slot.stats.find(candidate => {
            if (candidate?.source === 'charm') return false;
            const t = String(candidate?.title || '');
            return t === String(title) || (title === 'Counter-resist' && isCounterResistTitle(t));
        });
    }

    function stripCharmFromStatValue(rawValue, title, slot, charms) {
        let value = Number(rawValue);
        if (!Number.isFinite(value)) return 0;
        const level = getPlayerLevel();
        const weaponClass = resolveWeaponClass(slot);
        (charms || []).forEach(charm => {
            if (!charm || !CHARM_DEFS[charm.type]) return;
            const effect = getCharmEffect(charm.type, charm.size, weaponClass, level);
            if (!effect) return;
            if (title === 'Magic Accuracy' && (Number(effect.maccPercent) || Number(effect.maccFlat))) {
                value = (value - Number(effect.maccFlat || 0)) / (1 + Number(effect.maccPercent || 0) / 100);
            } else if (title === 'Magic Damage' && charm.type === 'archmage') {
                if (effect.percent) {
                    value = value / (1 + Number(effect.weaponMagicDamage || 0) / 100);
                } else if (Number(effect.weaponMagicDamage)) {
                    value = value - Number(effect.weaponMagicDamage);
                }
            } else if (title === 'Casting Speed' && charm.type === 'spellweaver' && Number(effect.castSpeed)) {
                value = value - Number(effect.castSpeed || 0);
            } else if (title === 'Magic Crit Damage' && charm.type === 'annihilator' && Number(effect.critDamage)) {
                value = value - Number(effect.critDamage || 0);
            } else if ((title === 'Mana Conservation' || title === 'Mana Cost') && (charm.type === 'aether' || charm.type === 'economizer') && Number(effect.manaCostReduction)) {
                value = value - Number(effect.manaCostReduction || 0);
            }
        });
        return Math.max(0, value);
    }

    function getPureEquipmentStatValue(slot, title, levelMap, charms) {
        if (!slot || !Array.isArray(slot.stats)) return 0;
        const stat = getEquipmentStatForTitle(slot, title);
        if (!stat) return 0;
        const currentValue = Number(stat.val);
        if (!Number.isFinite(currentValue)) return 0;
        const pureCurrent = stripCharmFromStatValue(currentValue, stat.title, slot, charms);
        if (stat.scalesWithUpgrade === false) return Math.max(0, pureCurrent);
        const levels = levelMap?.[slot.index] || slot;
        const currentLevel = Number(levels?.forge || 0) + Number(levels?.iw || 0);
        const initialLevel = Number(slot.forge || 0) + Number(slot.iw || 0);
        const rate = Number.isFinite(Number(stat.rate)) ? Number(stat.rate) : 1;
        const denominator = 1 + initialLevel * rate / 100;
        if (denominator <= 0) return Math.max(0, pureCurrent);
        return Math.max(0, pureCurrent / denominator * (1 + currentLevel * rate / 100));
    }

    function getSlotAttackCharms(slot, index) {
        if (!slot) return [];
        const list = Array.isArray(slot.actualCharms)
            ? slot.actualCharms
            : Array.isArray(slot.charmInfo)
                ? slot.charmInfo
                : (slot.eid && CHARM_INFO_CACHE.get(Number(slot.eid))) || [];
        const key = getCharmSlotKey(slot, index);
        const weaponClass = resolveWeaponClass(slot);
        const defenseSlot = key === 'main' ? false : key === 'off' ? weaponClass === 'shield' : true;
        return (list || []).filter(charm => {
            const def = charm && CHARM_DEFS[charm.type];
            return def && (defenseSlot ? def.category === 'defense' : def.category === 'attack');
        });
    }

    function addAttackCharmContributions(total, slot, index, levelMap, charms) {
        if (!slot || !charms || !charms.length) return;
        const level = getPlayerLevel();
        const weaponClass = resolveWeaponClass(slot);
        const sectionFor = (title) => {
            const stat = getEquipmentStatForTitle(slot, title);
            return stat?.section || 'ex';
        };
        charms.forEach(charm => {
            const effect = getCharmEffect(charm.type, charm.size, weaponClass, level);
            if (!effect) return;
            const targets = [];
            if (Number(effect.maccPercent) || Number(effect.maccFlat)) {
                targets.push({ title: 'Magic Accuracy', pct: Number(effect.maccPercent) || 0, flat: Number(effect.maccFlat) || 0 });
            }
            if (charm.type === 'archmage' && (Number(effect.weaponMagicDamage) || effect.percent)) {
                targets.push({
                    title: 'Magic Damage',
                    pct: effect.percent ? Number(effect.weaponMagicDamage) || 0 : 0,
                    flat: effect.percent ? 0 : Number(effect.weaponMagicDamage) || 0,
                });
            }
            if (Number(effect.castSpeed)) {
                targets.push({ title: 'Casting Speed', pct: 0, flat: Number(effect.castSpeed) });
            }
            if (Number(effect.critDamage)) {
                targets.push({ title: 'Magic Crit Damage', pct: 0, flat: Number(effect.critDamage) });
            }
            targets.forEach(({ title, pct, flat }) => {
                if (!getEquipmentStatForTitle(slot, title)) return;
                const pure = getPureEquipmentStatValue(slot, title, levelMap, charms);
                if (!Number.isFinite(pure)) return;
                const value = pure * pct / 100 + flat;
                const key = title + '|' + sectionFor(title);
                total[key] = (Number(total[key]) || 0) + value;
            });
        });
    }
    function getSlotCounterResistValue(slot, levelMap) {
        if (!slot || !slot.available) return 0;

        const initialLevel = Number(slot.forge || 0) + Number(slot.iw || 0);
        const levels = levelMap?.[slot.index] || slot;
        const currentLevel = Number(levels.forge || 0) + Number(levels.iw || 0);

        let counterStats = Array.isArray(slot.stats)
            ? slot.stats.filter(stat => isCounterResistTitle(stat.title))
            : [];
        if (counterStats.length === 0 && slot.counterResistValue !== null && slot.counterResistValue !== undefined &&
            Number.isFinite(Number(slot.counterResistValue))) {
            counterStats = [{
                val: Number(slot.counterResistValue),
                rate: Number.isFinite(Number(slot.counterResistRate)) ? Number(slot.counterResistRate) : 1,
                scalesWithUpgrade: slot.counterResistScalesWithUpgrade !== false,
                source: 'equipment',
            }];
        }

        const cachedCharmBonus = slot.eid
            ? Number(COUNTER_RESIST_CHARM_CACHE.get(Number(slot.eid)))
            : 0;
        const charmBonus = Number(slot.counterResistCharmBonus) > 0
            ? Number(slot.counterResistCharmBonus)
            : (Number.isFinite(cachedCharmBonus) && cachedCharmBonus > 0 ? cachedCharmBonus : 0);
        const hasSeparateCharmStat = counterStats.some(stat => stat?.source === 'charm');
        let inlineCharm = false;
        let total = 0;
        for (const stat of counterStats) {
            let value;
            if (charmBonus > 0 && stat?.source !== 'charm') {
                const split = splitCounterResistCharmValue(stat, charmBonus);
                if (split.charmOnly) {
                    inlineCharm = true;
                    value = hasSeparateCharmStat ? 0 : charmBonus;
                } else if (split.includesCharm) {
                    const normalizedStat = {
                        ...stat,
                        val: split.equipmentValue,
                        baseValue: undefined,
                    };
                    value = getCounterResistStatValue(normalizedStat, initialLevel, currentLevel);
                } else {
                    value = getCounterResistStatValue(stat, initialLevel, currentLevel);
                }
            } else {
                value = getCounterResistStatValue(stat, initialLevel, currentLevel);
            }

            if (Number.isFinite(value)) {
                total += value;
            }
        }

        if (charmBonus > 0 && !hasSeparateCharmStat && !inlineCharm) {
            total += charmBonus;
        }
        return Number.isFinite(total) ? total : 0;
    }

    function getEquipmentCounterResistValue(equipSlots, levelMap) {
        if (!Array.isArray(equipSlots)) return null;

        let total = 0;
        let found = false;
        equipSlots.forEach((slot, index) => {
            const slotId = Number(slot?.slotId);
            const isHand = slotId === 1 || slotId === 2 || (slot?.slotId == null && index < 2);
            if (!isHand || !slot?.available) return;
            const value = getSlotCounterResistValue(slot, levelMap);
            const hasCounterResist =
                (slot.counterResistValue !== null && slot.counterResistValue !== undefined &&
                    Number.isFinite(Number(slot.counterResistValue))) ||
                (Array.isArray(slot.stats) && slot.stats.some(stat => isCounterResistTitle(stat.title)));
            if (hasCounterResist) {
                total += value;
                found = true;
            }
        });

        return found && Number.isFinite(total) ? total : null;
    }

    function getActiveSimulatedCRValue() {
        if (!activeUpgradeSimulation) return null;
        return getEquipmentCounterResistValue(
            activeUpgradeSimulation.equipSlots,
            activeUpgradeSimulation.state
        );
    }

    let charmSimulation = null;

    function notifyMaccSimulationChanged() {
        if (charmSimulation && typeof charmSimulation.refresh === 'function') {
            charmSimulation.refresh();
        }
        refreshMaccCheckPanel();
    }

    function getPlayerLevel() {
        const el = document.querySelector('#level_readout .fc4');
        if (!el) return 1;
        const match = el.textContent.match(/Lv\.(\d+)/);
        return match ? parseInt(match[1]) : 1;
    }
    let maccCheckStyleAdded = false;
    let maccCheckObserver = null;
    let maccCheckMageResizeObserver = null;
    let maccCheckResizeBound = false;
    let maccCheckMageResizeTarget = null;
    let maccCheckDomBound = false;

    function ensureMaccCheckStyle() {
        if (maccCheckStyleAdded) return;
        maccCheckStyleAdded = true;
        const css = [
            '#hv-macc-panel { position:absolute; bottom:100px; right:100%; margin-right:10px; border:2px solid var(--color-border-default, #5C0D11); border-radius:9px; padding:5px 10px; background:var(--color-bg-default, #EDEBDF); color:var(--color-font-default, #5C0D11); white-space:nowrap; font-size:10pt; line-height:18px; z-index:4; }',
            '#hv-macc-panel p { margin:0 0 3px; font-size:10pt; font-weight:bold; }',
            '#hv-macc-panel table { font-size:9pt; line-height:18px; white-space:nowrap; border-collapse:collapse; }',
            '#hv-macc-panel td { padding:1px 0; }',
            '#hv-macc-panel td:first-child { text-align:right; padding-right:6px; color:var(--color-font-default, #5C0D11); }',
            '#hv-macc-panel td:last-child { text-align:left; color:var(--color-font-highlight, #c00); }',
        ].join('\n');
        if (typeof GM_addStyle === 'function') GM_addStyle(css);
        else {
            const style = document.createElement('style');
            style.textContent = css;
            document.head.appendChild(style);
        }
    }

    function positionMaccCheckPanel() {
        const panel = document.getElementById('hv-macc-panel');
        const stats = document.getElementById('eqch_stats');
        if (!panel || !stats) return;
        const mage = stats.querySelector('.hvut-eq-stats');
        if (mage && typeof ResizeObserver === 'function') {
            if (maccCheckMageResizeObserver && maccCheckMageResizeTarget !== mage) {
                maccCheckMageResizeObserver.disconnect();
                maccCheckMageResizeObserver = null;
                maccCheckMageResizeTarget = null;
            }
            if (!maccCheckMageResizeObserver) {
                maccCheckMageResizeObserver = new ResizeObserver(positionMaccCheckPanel);
                maccCheckMageResizeObserver.observe(mage);
                maccCheckMageResizeTarget = mage;
            }
        } else if (maccCheckMageResizeObserver) {
            maccCheckMageResizeObserver.disconnect();
            maccCheckMageResizeObserver = null;
            maccCheckMageResizeTarget = null;
        }
        const mageWidth = mage ? mage.offsetWidth : 0;
        if (mage && mageWidth > 0) {
            panel.style.right = 'calc(100% + ' + (mageWidth + 10) + 'px)';
            panel.style.marginRight = '10px';
        } else {
            panel.style.right = '100%';
            panel.style.marginRight = '10px';
        }
    }

    function ensureMaccCheckPanel() {
        const stats = document.getElementById('eqch_stats');
        if (!stats) return null;
        ensureMaccCheckStyle();
        let panel = document.getElementById('hv-macc-panel');
        if (!panel) {
            panel = document.createElement('div');
            panel.id = 'hv-macc-panel';
            panel.innerHTML =
                '<p>穿抗检查</p><table><tbody>' +
                '<tr><td>当前CR</td><td data-role="cr">--</td></tr>' +
                '<tr><td>当前PF</td><td data-role="rf">--</td></tr>' +
                '<tr><td>当前Macc</td><td data-role="macc">--</td></tr>' +
                '<tr><td>穿抗所需Macc</td><td data-role="required">--</td></tr>' +
                '<tr><td>结论</td><td data-role="qualified">--</td></tr>' +
                '</tbody></table>';
            stats.appendChild(panel);
        }
        if (!maccCheckObserver && typeof MutationObserver === 'function') {
            maccCheckObserver = new MutationObserver(positionMaccCheckPanel);
            maccCheckObserver.observe(stats, { childList: true, subtree: true });
        }
        if (!maccCheckResizeBound) {
            maccCheckResizeBound = true;
            window.addEventListener('resize', positionMaccCheckPanel);
        }
        if (!maccCheckDomBound) {
            maccCheckDomBound = true;
            document.addEventListener('change', event => {
                if (event.target?.closest?.('#hv-charm-popup')) {
                    window.setTimeout(refreshMaccCheckPanel, 0);
                }
            }, true);
            const scrollable = document.getElementById('stats_scrollable');
            if (scrollable && typeof MutationObserver === 'function') {
                const statsObserver = new MutationObserver(() => refreshMaccCheckPanel());
                statsObserver.observe(scrollable, { childList: true, subtree: true, characterData: true });
            }
        }
        positionMaccCheckPanel();
        return panel;
    }

    function findLivePanelRow(sectionKeywords, nameKeywords) {
        const stats = document.getElementById('stats_scrollable');
        if (!stats) return null;
        for (const table of stats.querySelectorAll('table')) {
            const section = getTableSectionTitle(table);
            if (!section || !sectionKeywords.some(keyword => section.includes(keyword))) continue;
            for (const tr of table.querySelectorAll('tr')) {
                const cells = tr.cells;
                if (!cells || cells.length < 2) continue;
                const name = cells[1].textContent.trim();
                if (nameKeywords.some(keyword => name.toLowerCase().includes(keyword.toLowerCase()))) {
                    return { td1: cells[0], td2: cells[1], panelName: name };
                }
            }
        }
        return null;
    }

    function getLivePanelValue(sectionKeywords, nameKeywords) {
        const item = findLivePanelRow(sectionKeywords, nameKeywords);
        return item ? readLiveRowIncrement(item).value : null;
    }

    function getMagicAccuracyWithIncrements() {
        const enRow = findEnglishPanelRow('magic', 'Accuracy');
        if (enRow) {
            const liveItem = findLiveRowByEnglishRow('magic', enRow);
            if (liveItem) return readLiveRowIncrement(liveItem).value;
            return enRow.value;
        }
        return getLivePanelValue(['Magic Attack', '魔法攻击'], ['Accuracy', '命中']);
    }

    function getMagicProficiencyWithIncrements() {
        const spellRows = [
            ['Fire', '火'],
            ['Cold', '冰'],
            ['Elec', '雷'],
            ['Wind', '风'],
            ['Holy', '圣'],
            ['Dark', '暗'],
        ];
        let bestName = '';
        let bestValue = -Infinity;
        for (const [enName, zhName] of spellRows) {
            let value = null;
            const enRow = findEnglishPanelRow('spell', enName);
            if (enRow) {
                const liveItem = findLiveRowByEnglishRow('spell', enRow);
                value = liveItem ? readLiveRowIncrement(liveItem).value : enRow.value;
            }
            if (value === null || !Number.isFinite(value)) {
                value = getLivePanelValue(['Spell Damage Bonus', '法术伤害加成'], [enName, zhName]);
            }
            if (value === null || !Number.isFinite(value)) continue;
            if (value > bestValue) {
                bestValue = value;
                bestName = enName;
            }
        }
        if (!bestName) return null;

        let profName = 'Elemental';
        let profKeywords = ['Elemental', '元素'];
        if (/holy/i.test(bestName)) {
            profName = 'Divine';
            profKeywords = ['Divine', '神圣'];
        } else if (/dark|forbidden/i.test(bestName)) {
            profName = 'Forbidden';
            profKeywords = ['Forbidden', '黑暗'];
        }

        const enRow = findEnglishPanelRow('proficiency', profName);
        if (enRow) {
            const liveItem = findLiveRowByEnglishRow('proficiency', enRow);
            if (liveItem) return readLiveRowIncrement(liveItem).value;
            return enRow.value;
        }
        return getLivePanelValue(['Effective Proficiency', '熟练度'], profKeywords);
    }

    function getCurrentCounterResist() {
        let raw = null;
        if (activeUpgradeSimulation) {
            raw = getActiveSimulatedCRValue();
            if (raw === null) {
                raw = getEquipmentCounterResistValue(activeUpgradeSimulation.equipSlots, activeUpgradeSimulation.state);
            }
        } else {
            raw = getEquipmentCounterResistValue(getEquipmentData(), null);
        }
        if (!Number.isFinite(raw)) raw = 0;
        const charmDelta = charmSimulation && typeof charmSimulation.getCounterResistPanelDelta === 'function'
            ? (Number(charmSimulation.getCounterResistPanelDelta()) || 0)
            : 0;
        return raw + charmDelta;
    }

    async function refreshMaccCheckPanel() {
        if (!isEquipmentPage()) return;
        const panel = ensureMaccCheckPanel();
        if (!panel) return;
        renderMaccCheckPanel();
        if (!gEnglishStatsPanel) {
            await ensureEnglishStatsPanel();
            if (isEquipmentPage() && document.getElementById('hv-macc-panel')?.isConnected) renderMaccCheckPanel();
        }
    }

    function renderMaccCheckPanel() {
        const panel = document.getElementById('hv-macc-panel');
        if (!panel || !panel.isConnected) return;
        const level = getPlayerLevel();
        const prof = getMagicProficiencyWithIncrements();
        const cr = getCurrentCounterResist();
        const macc = getMagicAccuracyWithIncrements();
        const crCell = panel.querySelector('[data-role="cr"]');
        const rfCell = panel.querySelector('[data-role="rf"]');
        const maccCell = panel.querySelector('[data-role="macc"]');
        const requiredCell = panel.querySelector('[data-role="required"]');
        const qualifiedCell = panel.querySelector('[data-role="qualified"]');
        if (!crCell || !rfCell || !maccCell || !requiredCell || !qualifiedCell) return;

        if (Number.isFinite(cr)) {
            crCell.textContent = cr.toFixed(2) + '%';
        } else {
            crCell.textContent = '--';
        }

        const rf = Number.isFinite(prof) && prof > 0 && level > 0
            ? Math.min(1, (prof - level) / level)
            : null;
        if (rf !== null) {
            rfCell.textContent = rf.toFixed(4);
        } else {
            rfCell.textContent = '--';
        }

        if (Number.isFinite(macc)) {
            maccCell.textContent = macc.toFixed(2);
        } else {
            maccCell.textContent = '--';
        }

        if (rf !== null && Number.isFinite(cr) && Number.isFinite(macc)) {
            const crDecimal = cr / 100;
            const required = level * 2.5 * (1 - (crDecimal + rf / 2)) * 3 - 100;
            const qualified = macc >= required;
            requiredCell.textContent = required.toFixed(2);
            qualifiedCell.textContent = qualified ? '你过关!' : '纯度太低了';
            qualifiedCell.style.color = qualified ? '#006400' : '#b00020';
            qualifiedCell.style.fontWeight = 'bold';
        } else {
            requiredCell.textContent = '--';
            qualifiedCell.textContent = '--';
            qualifiedCell.style.color = '';
            qualifiedCell.style.fontWeight = '';
        }
    }

    let gBasePrimaryStats = null;
    let gBaseStatsFetched = false;
    let gBaseStatsRequest = null;

    function fetchBasePrimaryStats(callback) {
        if (gBaseStatsFetched && gBasePrimaryStats) {
            callback(gBasePrimaryStats);
            return;
        }

        const deliver = stats => callback(stats || null);
        if (gBaseStatsRequest) {
            gBaseStatsRequest.then(deliver, () => deliver(null));
            return;
        }

        try {
            const stored = GM_getValue(BASE_STATS_CACHE_KEY, null);
            const cached = typeof stored === 'string' ? JSON.parse(stored) : stored;
            if (cached && cached.timestamp && cached.stats && Date.now() - cached.timestamp < BASE_STATS_CACHE_TTL) {
                gBasePrimaryStats = cached.stats;
                gBaseStatsFetched = true;
                callback(gBasePrimaryStats);
                return;
            }
        } catch (e) {}

        const request = new Promise(resolve => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: 'https://hentaiverse.org/?s=Character&ss=ch',
        timeout: 10000,
        onload: function(response) {
          if (response.status !== 200) {
            resolve(null);
            return;
          }

          const parser = new DOMParser();
          const doc = parser.parseFromString(response.responseText, 'text/html');
          const attrMap = { str: 'Strength', dex: 'Dexterity', agi: 'Agility', end: 'Endurance', int: 'Intelligence', wis: 'Wisdom' };
          const base = {};
          const pa = {};
          let isekai = 0;

          const attrTable = doc.querySelector('#attr_table');
          if (attrTable) {
            const rows = attrTable.querySelectorAll('tr');
            for (let i = 0; i < rows.length - 1; i++) {
              const row = rows[i];
              const cells = row.querySelectorAll('td');
              if (cells.length < 2) continue;
              const decImg = row.querySelector('#str_dec, #dex_dec, #agi_dec, #end_dec, #int_dec, #wis_dec');
              if (!decImg) continue;
              const key = Object.keys(attrMap).find(name => decImg.id === `${name}_dec`);
              if (!key) continue;
              const baseVal = parseFloat(cells[1].textContent.trim());
              if (!isNaN(baseVal)) base[key] = baseVal;
              const paSpan = cells[2] ? cells[2].querySelector('.fcr') : null;
              if (paSpan) {
                const paVal = parseFloat(paSpan.textContent.trim().replace('+', ''));
                if (!isNaN(paVal)) pa[key] = paVal;
              }
            }
          }

          const pabonusDiv = doc.querySelector('#pabonus');
          if (pabonusDiv) {
            const match = pabonusDiv.textContent.match(/Isekai bonus:\s*\+(\d+)/i);
            if (match) isekai = parseInt(match[1], 10);
          }

          const total = {};
          for (const key of Object.keys(attrMap)) {
            total[key] = (base[key] || 0) + (pa[key] || 0) + isekai;
          }
          resolve(total);
        },
        onerror: function() {
          resolve(null);
        },
        ontimeout: function() {
          resolve(null);
        }
      });
    });

    gBaseStatsRequest = request;
    request.then(stats => {
      if (gBaseStatsRequest === request) gBaseStatsRequest = null;
      if (!stats) return;
      gBasePrimaryStats = stats;
      gBaseStatsFetched = true;
      try {
        GM_setValue(BASE_STATS_CACHE_KEY, JSON.stringify({ timestamp: Date.now(), stats }));
      } catch (e) {}
    });
    request.then(deliver, () => deliver(null));
  }

  function calculateEquipPrimaryBonus(equipSlots, levelMap) {
    const primaryKeys = ['Strength', 'Dexterity', 'Agility', 'Endurance', 'Intelligence', 'Wisdom'];
    const result = {};
    primaryKeys.forEach(k => result[k] = 0);

    for (const slot of equipSlots) {
      if (!slot.available || !slot.stats.length) continue;
      let levels;
      if (typeof levelMap === 'function') {
        levels = levelMap(slot.index);
      } else {
        levels = levelMap[slot.index] || { forge: slot.forge, iw: slot.iw };
      }
      const newTotalLevel = levels.forge + levels.iw;
      const initialTotalLevel = slot.forge + slot.iw;

      for (const stat of slot.stats) {
        if (!primaryKeys.includes(stat.title)) continue;
        const rate = stat.rate || 1;
        const baseVal = stat.baseValue ?? (initialTotalLevel === 0
          ? stat.val
          : stat.val / (1 + initialTotalLevel * rate / 100));
        if (!isFinite(baseVal) || baseVal <= 0) continue;
        const currentVal = baseVal * (1 + newTotalLevel * rate / 100);
        result[stat.title] = (result[stat.title] || 0) + currentVal;
      }
    }
    const map = { 'Strength': 'str', 'Dexterity': 'dex', 'Agility': 'agi', 'Endurance': 'end', 'Intelligence': 'int', 'Wisdom': 'wis' };
    const mapped = {};
    for (const [en, val] of Object.entries(result)) {
      const short = map[en];
      if (short) mapped[short] = val;
    }
    return mapped;
  }

  function calculateDerivedIncrements(basePrimary, equipInit, equipCurr, playerLevel, tankSettings) {
    const { hpTankLevel, mpTankLevel, spTankLevel, hpPerk, mpPerk, spPerk } = tankSettings;
    const hpMult = 1 + (hpTankLevel || 0) * 0.1;
    const mpMult = 1 + (mpTankLevel || 0) * 0.1;
    const spMult = 1 + (spTankLevel || 0) * 0.1;
    const hpPerkMult = hpPerk ? 1.10 : 1;
    const mpPerkMult = mpPerk ? 1.10 : 1;
    const spPerkMult = spPerk ? 1.10 : 1;

    const keys = ['str', 'dex', 'agi', 'end', 'int', 'wis'];
    const initAttr = {};
    const currAttr = {};
    for (const k of keys) {
      initAttr[k] = (basePrimary[k] || 0) + (equipInit[k] || 0);
      currAttr[k] = (basePrimary[k] || 0) + (equipCurr[k] || 0);
    }

    const delta = {};
    for (const k of keys) {
      delta[k] = currAttr[k] - initAttr[k];
    }
    if (Object.values(delta).every(v => Math.abs(v) < 0.001)) return {};

    const logBase = 1.0003;
    const constTerm = 3330;
    const physBaseOld = Math.log(constTerm + initAttr.str * 2 + initAttr.dex) / Math.log(logBase) - 27039.81;
    const physBaseNew = Math.log(constTerm + currAttr.str * 2 + currAttr.dex) / Math.log(logBase) - 27039.81;
    const physBaseInc = physBaseNew - physBaseOld;
    const magBaseOld = Math.log(constTerm + initAttr.int * 2 + initAttr.wis) / Math.log(logBase) - 27039.81;
    const magBaseNew = Math.log(constTerm + currAttr.int * 2 + currAttr.wis) / Math.log(logBase) - 27039.81;
    const magBaseInc = magBaseNew - magBaseOld;

    const derived = {};
    if (Math.abs(physBaseInc) > 0.001) derived['Physical Damage|mainhand'] = physBaseInc;
    if (Math.abs(magBaseInc) > 0.001) derived['Magical Damage|magic'] = magBaseInc;

    const physAccInc = delta.dex * 0.5;
    if (Math.abs(physAccInc) > 0.001) derived['Accuracy|mainhand'] = physAccInc;
    const magAccInc = delta.wis * 0.5;
    if (Math.abs(magAccInc) > 0.001) derived['Accuracy|magic'] = magAccInc;

    const evadeInc = delta.agi * 0.4;
    if (Math.abs(evadeInc) > 0.001) derived['Evade|avoidance'] = evadeInc;

    const parryInc = delta.dex * 0.4;
    if (Math.abs(parryInc) > 0.001) derived['Parry|avoidance'] = parryInc;

    const resistInc = delta.wis * 0.4;
    if (Math.abs(resistInc) > 0.001) derived['Resist|avoidance'] = resistInc;

    const baseEndAgi = (initAttr.end + initAttr.agi / 2);
    const newEndAgi = (currAttr.end + currAttr.agi / 2);
    const physMitOld = 1 - 900 / (900 + baseEndAgi);
    const physMitNew = 1 - 900 / (900 + newEndAgi);
    const physMitInc = physMitNew - physMitOld;
    if (Math.abs(physMitInc) > 0.0001) derived['Physical|mitigation'] = physMitInc * 100;

    const baseEndWis = (initAttr.end + initAttr.wis / 2);
    const newEndWis = (currAttr.end + currAttr.wis / 2);
    const magMitOld = 1 - 900 / (900 + baseEndWis);
    const magMitNew = 1 - 900 / (900 + newEndWis);
    const magMitInc = magMitNew - magMitOld;
    if (Math.abs(magMitInc) > 0.0001) derived['Magical|mitigation'] = magMitInc * 100;

    const initHp = Math.floor(initAttr.end * 6 * hpMult * hpPerkMult);
    const currHp = Math.floor(currAttr.end * 6 * hpMult * hpPerkMult);
    const hpInc = currHp - initHp;
    if (Math.abs(hpInc) > 0.01) derived['Base Health|vitals'] = hpInc;

    const initMp = Math.floor(initAttr.wis * mpMult * mpPerkMult);
    const currMp = Math.floor(currAttr.wis * mpMult * mpPerkMult);
    const mpInc = currMp - initMp;
    if (Math.abs(mpInc) > 0.01) derived['Base Mana|vitals'] = mpInc;

    const initSp = Math.floor((initAttr.str + initAttr.dex + initAttr.agi + initAttr.end + initAttr.int + initAttr.wis) / 5 * spMult * spPerkMult);
    const currSp = Math.floor((currAttr.str + currAttr.dex + currAttr.agi + currAttr.end + currAttr.int + currAttr.wis) / 5 * spMult * spPerkMult);
    const spInc = currSp - initSp;
    if (Math.abs(spInc) > 0.01) derived['Base Spirit|vitals'] = spInc;

    const baseSpeed = Math.max(0, (initAttr.agi - playerLevel) * 0.1 / playerLevel);
    const currSpeed = Math.max(0, (currAttr.agi - playerLevel) * 0.1 / playerLevel);
    const asInc = currSpeed - baseSpeed;
    if (Math.abs(asInc) > 0.0001) derived['Attack Speed Bonus|mainhand'] = asInc * 100;

    return derived;
  }

  let tankSettings = (() => {
    const stored = GM_getValue(STORAGE_KEY_TANK) || (!IS_ISEKAI_PAGE ? GM_getValue(LEGACY_STORAGE_KEY_TANK) : null);
    if (stored) {
      try {
        return JSON.parse(stored);
      } catch(e) {}
    }
    return {
      hpTankLevel: 0,
      mpTankLevel: 0,
      spTankLevel: 0,
      hpPerk: false,
      mpPerk: false,
      spPerk: false,
    };
  })();

  function saveTankSettings() {
    GM_setValue(STORAGE_KEY_TANK, JSON.stringify(tankSettings));
  }

  let upgradePanel = null;
  let slotControls = [];
  let initialSimulated = {};
  let activeUpgradeSimulation = null;
  let activeUpgradeCRBaseline = null;
  let lastHoveredEquipmentId = null;
  const PANEL_INCREMENT_CLASS = 'hv-panel-increment';
  const PANEL_INCREMENT_SOURCE_UPGRADE = '装备升级';
  const PANEL_INCREMENT_SOURCE_DERIVED = '主属性派生';
  const PANEL_INCREMENT_SOURCE_CHARM = '护符';
  const PANEL_INCREMENT_SOURCES = new Map();

  function formatPanelIncrementValue(value) {
    const rounded = Math.round(value * 10000) / 10000;
    const text = Math.abs(rounded) >= 0.005 ? rounded.toFixed(2) : rounded.toFixed(4);
    return (rounded > 0 ? '+' : '') + text;
  }

  function setPanelIncrementSource(item, source, value) {
    const key = item?.tr || item?.td2;
    if (!key) return;
    let entry = PANEL_INCREMENT_SOURCES.get(key);
    if (!entry) {
      entry = { item, upgrade: 0, derived: 0, charm: 0 };
      PANEL_INCREMENT_SOURCES.set(key, entry);
    }
    entry.item = item;
    entry[source] = Number(value) || 0;
  }

  function clearPanelIncrementSources(source) {
    PANEL_INCREMENT_SOURCES.forEach(entry => {
      if (entry && source in entry) entry[source] = 0;
    });
  }

  function renderPanelIncrements() {
    document.querySelectorAll('.' + PANEL_INCREMENT_CLASS).forEach(node => node.remove());
    PANEL_INCREMENT_SOURCES.forEach((entry, key) => {
      if (!entry?.item?.td2 || entry.item.td2.isConnected === false) {
        PANEL_INCREMENT_SOURCES.delete(key);
        return;
      }
      const total = Number(entry.upgrade || 0) + Number(entry.derived || 0) + Number(entry.charm || 0);
      if (Math.abs(total) < 0.00005) {
        return;
      }
      const parts = [];
      const unit = entry.item.isPercent ? '%' : '';
      if (Math.abs(Number(entry.upgrade || 0)) >= 0.00001) parts.push(PANEL_INCREMENT_SOURCE_UPGRADE + ' ' + formatPanelIncrementValue(entry.upgrade) + unit);
      if (Math.abs(Number(entry.derived || 0)) >= 0.00001) parts.push(PANEL_INCREMENT_SOURCE_DERIVED + ' ' + formatPanelIncrementValue(entry.derived) + unit);
      if (Math.abs(Number(entry.charm || 0)) >= 0.00001) parts.push(PANEL_INCREMENT_SOURCE_CHARM + ' ' + formatPanelIncrementValue(entry.charm) + unit);
      const span = document.createElement('span');
      span.className = PANEL_INCREMENT_CLASS;
      span.style.cssText = 'color: ' + (total < 0 ? '#c00' : '#0a0') + '; font-weight: bold; margin-left: 5px; font-size: 7pt; vertical-align: baseline; line-height: 1; display: inline-block; cursor: help;';
      span.title = parts.join('\n');
      span.textContent = formatPanelIncrementValue(total) + unit;
      entry.item.td2.appendChild(span);
    });
  }

  function normalizePanelDisplayDiff(diff, name) {
    let value = Number(diff) || 0;
    if (String(name || '').includes('Mana Cost')) value = -value;
    return value;
  }


  let pairedPanelFocusBound = false;
  let panelFocusZIndex = 10000;
  function focusPairedPanel(panel) {
    const upgrade = document.getElementById('hv-upgrade-panel');
    const plan = document.getElementById('hvmepp-plan-overlay');
    const material = document.getElementById('hvmepp-overlay');
    const charm = document.getElementById('hv-charm-popup');
    const panels = [upgrade, plan, material, charm].filter(Boolean);
    if (!panels.includes(panel)) return;
    panelFocusZIndex = Math.max(panelFocusZIndex + 1, 10001);
    panel.style.setProperty('z-index', String(panelFocusZIndex), 'important');
  }

  function bindPairedPanelFocus() {
    if (pairedPanelFocusBound) return;
    pairedPanelFocusBound = true;
    const focusFromEvent = event => {
      const target = event.target;
      const focusedPanel = target?.closest?.('#hv-upgrade-panel, #hvmepp-plan-overlay, #hvmepp-overlay, #hv-charm-popup');
      if (focusedPanel) focusPairedPanel(focusedPanel);
    };
    document.addEventListener('mousedown', focusFromEvent, true);
    document.addEventListener('focusin', focusFromEvent, true);
  }

  function buildUpgradePanel(equipSlots) {
    fetchBasePrimaryStats(function(baseStats) {
      if (!baseStats) {
        alert('无法读取基础属性，请检查网络或刷新页面。蓝色增量可能不准确。');
      }
      _buildPanel(equipSlots, baseStats);
    });
  }

  function _buildPanel(equipSlots, baseStats) {
    slotControls = [];
    if (charmSimulation && typeof charmSimulation.resetHandState === 'function') charmSimulation.resetHandState();

    if (upgradePanel) {
      upgradePanel.remove();
      upgradePanel = null;
      activeUpgradeSimulation = null;
      activeUpgradeCRBaseline = null;
      if (charmSimulation && typeof charmSimulation.close === 'function') charmSimulation.close();
    }

    const panel = document.createElement('div');
    panel.id = 'hv-upgrade-panel';
    panel.style.cssText = `
            position: absolute;
            top: 120px;
            left: 260px;
            width: 310px;
            max-height: 85vh;
            overflow-y: auto;
            background: #f5f0e8;
            border: 2px solid #5c0d11;
            border-radius: 8px;
            padding: 0 10px 10px 10px;
            z-index: 9999;
            font-family: Verdana, sans-serif;
            font-size: 10pt;
            box-shadow: 0 4px 8px rgba(0,0,0,0.3);
            user-select: text;
            cursor: default;
        `;

    const closePanel = () => {
      const simulationCR = Number(activeUpgradeSimulation?.actualCR);
      if (Number.isFinite(simulationCR)) activeUpgradeCRBaseline = simulationCR;
      if (charmSimulation && typeof charmSimulation.close === 'function') charmSimulation.close();
      if (charmSimulation && typeof charmSimulation.resetHandState === 'function') charmSimulation.resetHandState();
      panel.remove();
      upgradePanel = null;
      activeUpgradeSimulation = null;
      restoreOriginalStats();
      notifyMaccSimulationChanged();
    };

    const header = document.createElement('div');
    header.style.cssText = `
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 6px 10px;
            margin: 0 -10px 8px -10px;
            border-bottom: 2px solid #a47c78;
            background: #d4cfc0;
            border-radius: 8px 8px 0 0;
            cursor: move;
            user-select: none;
            font-weight: bold;
            font-size: 11pt;
            color: #5c0d11;
        `;

    const headerLabels = document.createElement('div');
    headerLabels.style.cssText = 'display:flex; gap:8px; align-items:center;';

    const headerLabelStyle = [
      'padding: 2px 4px',
      'font-size: 12pt',
      'font-family: Verdana, sans-serif',
      'cursor: pointer',
      'color: #5C0D11',
      'user-select: none'
    ].join('; ');

    const headerMainLabel = document.createElement('span');
    headerMainLabel.textContent = '装备升级模拟';
    headerMainLabel.title = '显示装备升级模拟';
    headerMainLabel.style.cssText = headerLabelStyle;
    headerLabels.appendChild(headerMainLabel);

    const headerSettingsLabel = document.createElement('span');
    headerSettingsLabel.textContent = '设置';
    headerSettingsLabel.title = '显示设置';
    headerSettingsLabel.style.cssText = headerLabelStyle;
    headerLabels.appendChild(headerSettingsLabel);

    const headerCloseBtn = document.createElement('button');
    headerCloseBtn.type = 'button';
    headerCloseBtn.className = 'hvmepp-close';
    headerCloseBtn.textContent = '×';
    headerCloseBtn.title = '关闭';
    headerCloseBtn.setAttribute('aria-label', '关闭');
    headerCloseBtn.onclick = closePanel;
    header.appendChild(headerLabels);
    header.appendChild(headerCloseBtn);

    panel.appendChild(header);

    makeDraggable(panel, header);

    const content = document.createElement('div');
    content.style.cssText = 'max-height: calc(85vh - 60px); overflow-y: auto;';
    panel.appendChild(content);

    const settingsContent = document.createElement('div');
    settingsContent.style.cssText = 'max-height: calc(85vh - 60px); overflow-y: auto; display:none;';
    panel.appendChild(settingsContent);

    let settingsVisible = false;
    function setHeaderLabelActive(label, active) {
      label.style.color = '#5C0D11';
      label.style.textDecoration = 'none';
      label.style.fontWeight = active ? 'bold' : 'normal';
    }
    function setSettingsView(visible) {
      settingsVisible = Boolean(visible);
      content.style.display = settingsVisible ? 'none' : '';
      settingsContent.style.display = settingsVisible ? '' : 'none';
      setHeaderLabelActive(headerMainLabel, !settingsVisible);
      setHeaderLabelActive(headerSettingsLabel, settingsVisible);
    }
    headerMainLabel.addEventListener('click', () => setSettingsView(false));
    headerSettingsLabel.addEventListener('click', () => setSettingsView(true));
    setSettingsView(false);
    [headerMainLabel, headerSettingsLabel].forEach(label => {
      label.addEventListener('mouseenter', () => { label.style.color = '#9B4E03'; });
      label.addEventListener('mouseleave', () => {
        setHeaderLabelActive(headerMainLabel, !settingsVisible);
        setHeaderLabelActive(headerSettingsLabel, settingsVisible);
      });
    });

    const getRowHandKey = getCharmSlotKey;

    const createCharmAdjustButton = (slotKey) => {
      const label = document.createElement('span');
      label.textContent = '护符调整';
      label.dataset.charmSlot = slotKey;
      if (slotKey === 'main' || slotKey === 'off') label.dataset.charmHand = slotKey;
      label.title = '调整' + (CHARM_SLOT_LABELS[slotKey] || slotKey) + '护符并预览面板变化';
      label.style.cssText = 'cursor:pointer; color:#5C0D11; white-space:nowrap; padding:0 2px; user-select:none; font-size:9pt;';
      label.addEventListener('click', () => charmSimulation.open(slotKey));
      return label;
    };

    const state = {};
    const initialLevels = {};
    equipSlots.forEach(slot => {
      state[slot.index] = { forge: slot.forge, iw: slot.iw };
      initialLevels[slot.index] = { forge: slot.forge, iw: slot.iw };
    });

    equipSlots.forEach((slot, index) => {
      const row = document.createElement('div');
      row.style.cssText = `
                display: flex;
                align-items: center;
                gap: 4px;
                padding: 4px 0;
                border-bottom: 1px dotted #ccc;
                flex-wrap: nowrap;
            `;
      row.dataset.index = slot.index;

      const nameSpan = document.createElement('span');
      nameSpan.textContent = slot.slotName;
      nameSpan.style.cssText = 'font-weight: bold; width: 72px; flex: 0 0 72px;';
      const handKey = getRowHandKey(slot, index);

      if (!slot.available) {
        const reasonSpan = document.createElement('span');
        reasonSpan.textContent = slot.unavailableReason || '';
        reasonSpan.style.cssText = 'color: #999; font-style: italic;';
        row.append(nameSpan, reasonSpan);
        content.appendChild(row);
        return;
      }

      if (slot.stats.length === 0 || !slot.name) {
        const emptySpan = document.createElement('span');
        emptySpan.textContent = slot.unavailableReason || '';
        emptySpan.style.cssText = 'color: #999;';
        if (handKey) {
          const emptyCharmBtn = createCharmAdjustButton(handKey);
          charmSimulation.registerHandStatusEl(handKey, row);
          row.append(nameSpan, emptyCharmBtn, emptySpan);
        } else {
          row.append(nameSpan, emptySpan);
        }
        content.appendChild(row);
        return;
      }

      const forgeSpan = document.createElement('span');
      forgeSpan.textContent = `锻${slot.forge}`;
      forgeSpan.style.cssText = `
                font-weight: bold;
                cursor: pointer;
                padding: 0 4px;
                color: #000;
                min-width: 64px;
                height: 20px;
                line-height: 20px;
                text-align: center;
                display: inline-block;
                background:#e8e0d5; border-radius:3px;
                user-select: none;
                white-space: nowrap;
            `;
      forgeSpan.addEventListener('mousedown', function(e) {
        e.preventDefault();
        let delta = e.button === 0 ? 1 : -1;
        if (e.shiftKey) delta *= 5;
        const slotData = slot;
        const idx = slotData.index;
        const s = state[idx];
        let newVal = s.forge + delta;
        if (newVal < slotData.forge) newVal = slotData.forge;
        if (newVal > slotData.max) newVal = slotData.max;
        if (newVal === s.forge) return;
        s.forge = newVal;
        if (s.iw < s.forge) s.iw = s.forge;
        updateUI(idx);
      });
      forgeSpan.addEventListener('contextmenu', function(e) { e.preventDefault(); });

      const iwSpan = document.createElement('span');
      iwSpan.textContent = `IW${slot.iw}`;
      iwSpan.style.cssText = `
                font-weight: bold;
                cursor: pointer;
                padding: 0 4px;
                color: #000;
                min-width: 64px;
                height: 20px;
                line-height: 20px;
                text-align: center;
                display: inline-block;
                background:#e8e0d5; border-radius:3px;
                user-select: none;
                white-space: nowrap;
            `;
      iwSpan.addEventListener('mousedown', function(e) {
        e.preventDefault();
        let delta = e.button === 0 ? 1 : -1;
        if (e.shiftKey) delta *= 5;
        const slotData = slot;
        const idx = slotData.index;
        const s = state[idx];
        let newVal = s.iw + delta;
        if (newVal < slotData.iw) newVal = slotData.iw;
        if (newVal > slotData.max) newVal = slotData.max;
        if (newVal < s.forge) newVal = s.forge;
        if (newVal === s.iw) return;
        s.iw = newVal;
        updateUI(idx);
      });
      iwSpan.addEventListener('contextmenu', function(e) { e.preventDefault(); });

      const rowChildren = [nameSpan];
      if (handKey) rowChildren.push(createCharmAdjustButton(handKey));
      rowChildren.push(forgeSpan);
      rowChildren.push(iwSpan);
      if (handKey) {
        charmSimulation.registerHandStatusEl(handKey, row);
      }
      row.append(...rowChildren);
      content.appendChild(row);

      slotControls.push({ row, forgeSpan, iwSpan, slot, state });
    });

    if (charmSimulation && typeof charmSimulation.refresh === 'function') charmSimulation.refresh();

    const tankDiv = document.createElement('div');
    tankDiv.style.cssText = 'margin-top: 8px; padding: 6px 8px; border: 1px solid #ccc; border-radius: 4px; background: #e8e3d8;';
    const tankTitle = document.createElement('div');
    tankTitle.textContent = '基础属性乘数设置';
    tankTitle.style.cssText = 'font-weight: bold; font-size: 10pt; margin-bottom: 4px;';
    tankDiv.appendChild(tankTitle);

    const tankRow = document.createElement('div');
    tankRow.style.cssText = 'display: flex; flex-direction: column; gap: 4px; align-items: stretch;';

    const hpLabel = document.createElement('label');
    hpLabel.textContent = 'HP Tank: ';
    const hpInput = document.createElement('input');
    hpInput.type = 'number';
    hpInput.min = 0;
    hpInput.max = 10;
    hpInput.step = 1;
    hpInput.value = tankSettings.hpTankLevel;
    hpInput.style.width = '40px';
    hpInput.style.textAlign = 'center';
    hpLabel.appendChild(hpInput);
    const hpPerkLabel = document.createElement('label');
    hpPerkLabel.textContent = '天赋 ';
    const hpPerkCheck = document.createElement('input');
    hpPerkCheck.type = 'checkbox';
    hpPerkCheck.checked = tankSettings.hpPerk;
    hpPerkLabel.appendChild(hpPerkCheck);
    const hpRow = document.createElement('div');
    hpRow.style.cssText = 'display:flex; align-items:center; gap:12px; min-height:24px;';
    hpRow.append(hpLabel, hpPerkLabel);
    tankRow.appendChild(hpRow);

    const mpLabel = document.createElement('label');
    mpLabel.textContent = 'MP Tank: ';
    const mpInput = document.createElement('input');
    mpInput.type = 'number';
    mpInput.min = 0;
    mpInput.max = 10;
    mpInput.step = 1;
    mpInput.value = tankSettings.mpTankLevel;
    mpInput.style.width = '40px';
    mpInput.style.textAlign = 'center';
    mpLabel.appendChild(mpInput);
    const mpPerkLabel = document.createElement('label');
    mpPerkLabel.textContent = '天赋 ';
    const mpPerkCheck = document.createElement('input');
    mpPerkCheck.type = 'checkbox';
    mpPerkCheck.checked = tankSettings.mpPerk;
    mpPerkLabel.appendChild(mpPerkCheck);
    const mpRow = document.createElement('div');
    mpRow.style.cssText = 'display:flex; align-items:center; gap:12px; min-height:24px;';
    mpRow.append(mpLabel, mpPerkLabel);
    tankRow.appendChild(mpRow);

    const spLabel = document.createElement('label');
    spLabel.textContent = 'SP Tank: ';
    const spInput = document.createElement('input');
    spInput.type = 'number';
    spInput.min = 0;
    spInput.max = 10;
    spInput.step = 1;
    spInput.value = tankSettings.spTankLevel;
    spInput.style.width = '40px';
    spInput.style.textAlign = 'center';
    spLabel.appendChild(spInput);
    const spPerkLabel = document.createElement('label');
    spPerkLabel.textContent = '天赋 ';
    const spPerkCheck = document.createElement('input');
    spPerkCheck.type = 'checkbox';
    spPerkCheck.checked = tankSettings.spPerk;
    spPerkLabel.appendChild(spPerkCheck);
    const spRow = document.createElement('div');
    spRow.style.cssText = 'display:flex; align-items:center; gap:12px; min-height:24px;';
    spRow.append(spLabel, spPerkLabel);
    tankRow.appendChild(spRow);

    tankDiv.appendChild(tankRow);
    settingsContent.appendChild(tankDiv);

    const btnContainer = document.createElement('div');
    btnContainer.style.cssText = 'margin-top:8px; display:flex; gap:8px; flex-wrap:wrap;';
    const resetBtn = document.createElement('input');
    resetBtn.type = 'button';
    resetBtn.style.cssText = 'padding:3px 10px; font-size:11pt;';
    resetBtn.value = '重置计算';
    resetBtn.onclick = () => {
      if (charmSimulation && typeof charmSimulation.close === 'function') charmSimulation.close();
      if (charmSimulation && typeof charmSimulation.resetHandState === 'function') charmSimulation.resetHandState();
      resetSimulation(equipSlots, state);
    };
    const readBtn = document.createElement('input');
    readBtn.type = 'button';
    readBtn.style.cssText = 'padding:3px 10px; font-size:11pt;';
    readBtn.value = '读取等级';
    readBtn.onclick = function() {
      readTankLevels(equipSlots, state);
    };
    const materialBtn = document.createElement('input');
    materialBtn.type = 'button';
    materialBtn.style.cssText = 'padding:3px 10px; font-size:11pt;';
    materialBtn.value = '计算材料';
    materialBtn.onclick = function() {
      if (charmSimulation && typeof charmSimulation.close === 'function') charmSimulation.close();
      if (charmSimulation && typeof charmSimulation.resetHandState === 'function') charmSimulation.resetHandState();
      const previewState = {};
      slotControls.forEach(control => {
        const current = control.state[control.slot.index] || {};
        previewState[control.slot.index] = {
          forge: Number(current.forge) || control.slot.forge,
          iw: Number(current.iw) || control.slot.iw
        };
      });
      materialCalculator.openPlan(equipSlots, previewState);
    };
    btnContainer.append(resetBtn, materialBtn);
    content.appendChild(btnContainer);
    readBtn.style.marginTop = '8px';
    tankDiv.appendChild(readBtn);

    document.body.appendChild(panel);
    upgradePanel = panel;
    bindPairedPanelFocus(panel);
    focusPairedPanel(panel);

    function updateTankSettings() {
      tankSettings.hpTankLevel = parseInt(hpInput.value) || 0;
      tankSettings.mpTankLevel = parseInt(mpInput.value) || 0;
      tankSettings.spTankLevel = parseInt(spInput.value) || 0;
      tankSettings.hpPerk = hpPerkCheck.checked;
      tankSettings.mpPerk = mpPerkCheck.checked;
      tankSettings.spPerk = spPerkCheck.checked;
      saveTankSettings();
      applyIncrements(equipSlots, state);
    }

    hpInput.addEventListener('change', updateTankSettings);
    mpInput.addEventListener('change', updateTankSettings);
    spInput.addEventListener('change', updateTankSettings);
    hpPerkCheck.addEventListener('change', updateTankSettings);
    mpPerkCheck.addEventListener('change', updateTankSettings);
    spPerkCheck.addEventListener('change', updateTankSettings);

    function readTankLevels(equipSlots, state) {
      const isIsekaiPage = IS_ISEKAI_PAGE;
      GM_xmlhttpRequest({
        method: 'GET',
        url: `https://hentaiverse.org${isIsekaiPage ? '/isekai/' : '/'}?s=Character&ss=ab`,
        onload: function(response) {
          if (response.status === 200) {
            const parser = new DOMParser();
            const doc = parser.parseFromString(response.responseText, 'text/html');
            const titleDivs = doc.querySelectorAll('.fc2.far.fcb');
            const parseTankText = (value) => {
              const text = String(value || '').replace(/\s+/g, ' ').trim();
              if (!text) return null;
              if (/Maxed|At Maximum/i.test(text)) return 10;
              const fractionMatch = text.match(/(\d+)\s*\/\s*(\d+)/);
              if (fractionMatch) {
                return Math.min(parseInt(fractionMatch[1], 10), parseInt(fractionMatch[2], 10));
              }
              const levelMatch = text.match(/Level\s*[:：]?\s*(\d+)/i);
              if (levelMatch) return parseInt(levelMatch[1], 10);
              const numberMatch = text.match(/^\s*(\d+)/);
              return numberMatch ? parseInt(numberMatch[1], 10) : null;
            };
            const parseTank = (name) => {
              for (const div of titleDivs) {
                if (div.textContent.trim() === name) {
                  let parent = div.parentElement;
                  while (parent && !parent.querySelector('.fc4.fac.fcb')) {
                    parent = parent.parentElement;
                  }
                  if (parent) {
                    const levelDiv = parent.querySelector('.fc4.fac.fcb');
                    if (levelDiv) {
                      const level = parseTankText(levelDiv.textContent);
                      if (level !== null) return level;
                    }
                  }
                  return null;
                }
              }
              return null;
            };
            const parseTankTreeLevel = (slotId) => {
              const treeSlot = doc.querySelector(`#slot_${slotId + 1000}`);
              if (!treeSlot) return null;
              let section = treeSlot.parentElement;
              while (section && !section.querySelector('.aw10')) {
                section = section.parentElement;
              }
              const barContainer = section ? section.querySelector('.aw10') : null;
              if (!barContainer) return null;
              const activeBars = Array.from(barContainer.children).filter(bar => {
                const style = (bar.getAttribute('style') || '').toLowerCase();
                return /10rf(?:\.png)?/i.test(style);
              }).length;
              return activeBars > 0 ? Math.min(activeBars, 10) : null;
            };
            const parseTankSlotLevel = (slotId) => {
              const slot = doc.querySelector(`#slot_${slotId}`);
              const domLevel = slot ? parseTankText(slot.textContent) : null;
              if (domLevel !== null) return domLevel;
              const treeLevel = parseTankTreeLevel(slotId);
              if (treeLevel !== null) return treeLevel;

              const sourcePattern = new RegExp(
                `<div\\b[^>]*\\bid=["']slot_${slotId}["'][^>]*>[\\s\\S]*?<span\\b[^>]*>([\\s\\S]*?)<\\/span>`,
                'i'
              );
              const sourceMatch = response.responseText.match(sourcePattern);
              if (!sourceMatch) return null;
              const sourceText = sourceMatch[1].replace(/<[^>]*>/g, ' ');
              return parseTankText(sourceText);
            };
            const parseTankForPage = (slotId, name) => {
              const slotLevel = parseTankSlotLevel(slotId);
              if (slotLevel !== null) return slotLevel;
              return isIsekaiPage ? null : parseTank(name);
            };
            const hp = parseTankForPage(101, 'HP Tank');
            const mp = parseTankForPage(102, 'MP Tank');
            const sp = parseTankForPage(103, 'SP Tank');
            let loadedCount = 0;
            if (hp !== null) { tankSettings.hpTankLevel = hp; hpInput.value = hp; loadedCount++; }
            if (mp !== null) { tankSettings.mpTankLevel = mp; mpInput.value = mp; loadedCount++; }
            if (sp !== null) { tankSettings.spTankLevel = sp; spInput.value = sp; loadedCount++; }
            saveTankSettings();
            applyIncrements(equipSlots, state);
            if (loadedCount === 3) {
              showToast(`等级读取成功：HP ${hp ?? '-'} / MP ${mp ?? '-'} / SP ${sp ?? '-'}`);
            } else {
              showToast(`未读取到完整 Tank 等级（${loadedCount}/3），请检查技能页面请求结果`);
            }
          } else {
            alert('读取等级失败，请检查网络或重试。');
          }
        },
        onerror: function() {
          alert('读取等级失败，请检查网络或重试。');
        }
      });
    }

    const initialSim = calculateTotalStats(equipSlots, state);
    initialSimulated = initialSim;
    const equipmentActualCR = getEquipmentCounterResistValue(equipSlots, null);
    const actualCR = Number.isFinite(equipmentActualCR) ? equipmentActualCR : null;
    activeUpgradeSimulation = {
      equipSlots,
      state,
      initialStats: initialSim,
      actualCR: Number.isFinite(actualCR) ? actualCR : null,
      refreshEquipmentData,
    };
    activeUpgradeCRBaseline = Number.isFinite(actualCR) ? actualCR : null;
    const playerLevel = getPlayerLevel();

    function refreshMaterialPlan() {
      if (materialCalculator && typeof materialCalculator.updatePlan === 'function') {
        materialCalculator.updatePlan(equipSlots, state);
      }
    }

    function refreshEquipmentData() {
      if (!activeUpgradeSimulation) return;

      const previousState = {};
      Object.keys(state).forEach(index => {
        previousState[index] = { ...state[index] };
      });

      const latestSlots = getEquipmentData();
      equipSlots.splice(0, equipSlots.length, ...latestSlots);

      Object.keys(state).forEach(index => delete state[index]);
      Object.keys(initialLevels).forEach(index => delete initialLevels[index]);
      latestSlots.forEach(slot => {
        const previous = previousState[slot.index];
        state[slot.index] = previous || { forge: slot.forge, iw: slot.iw };
        initialLevels[slot.index] = { forge: slot.forge, iw: slot.iw };
      });

      slotControls.forEach(control => {
        const refreshedSlot = latestSlots.find(slot => slot.index === control.slot.index);
        if (refreshedSlot) control.slot = refreshedSlot;
        control.state = state;
      });

      const refreshedInitialStats = calculateTotalStats(equipSlots, initialLevels);
      initialSimulated = refreshedInitialStats;
      activeUpgradeSimulation.equipSlots = equipSlots;
      activeUpgradeSimulation.state = state;
      activeUpgradeSimulation.initialStats = refreshedInitialStats;

      const refreshedCR = getEquipmentCounterResistValue(equipSlots, null);
      if (Number.isFinite(refreshedCR)) {
        activeUpgradeSimulation.actualCR = refreshedCR;
        activeUpgradeCRBaseline = refreshedCR;
      }

      applyIncrements(equipSlots, state);
      refreshMaterialPlan();
      notifyMaccSimulationChanged();
    }

    function resetSimulation(equipSlots, state) {
      equipSlots.forEach(slot => {
        state[slot.index].forge = slot.forge;
        state[slot.index].iw = slot.iw;
        updateUI(slot.index);
      });
    }

    function setLevelText(element, label, base, increment) {
      element.textContent = `${label}${base}`;
      if (increment > 0) {
        const incrementSpan = document.createElement('span');
        incrementSpan.style.color = '#0a0';
        incrementSpan.textContent = `+${increment}`;
        element.appendChild(incrementSpan);
      }
    }

    function updateUI(idx) {
      const control = slotControls.find(c => c.slot.index === idx);
      if (!control) return;
      const s = control.state[idx];
      const forgeBase = control.slot.forge;
      const iwBase = control.slot.iw;
      const forgeInc = s.forge - forgeBase;
      const iwInc = s.iw - iwBase;
      setLevelText(control.forgeSpan, '锻', forgeBase, forgeInc);
      setLevelText(control.iwSpan, 'IW', iwBase, iwInc);
      applyIncrements(equipSlots, state);
      refreshMaterialPlan();
      notifyMaccSimulationChanged();
    }

    function applyIncrements(equipSlots, state) {
      if (!gEnglishStatsPanel) {
        ensureEnglishStatsPanel().then(panel => {
          if (panel) applyIncrements(equipSlots, state);
        });
        return;
      }

      const currentSim = calculateTotalStats(equipSlots, state);
      const increments = {};
      const statKeys = new Set([
        ...Object.keys(initialSimulated),
        ...Object.keys(currentSim),
      ]);
      for (const key of statKeys) {
        const value = Number(currentSim[key] ?? 0);
        const initialValue = Number(initialSimulated[key] ?? 0);
        const diff = value - initialValue;
        if (Number.isFinite(diff) && Math.abs(diff) > 0.001) {
          increments[key] = diff;
        }
      }

      let derivedIncrements = {};
      if (baseStats) {
        const equipInit = calculateEquipPrimaryBonus(equipSlots, initialLevels);
        const equipCurr = calculateEquipPrimaryBonus(equipSlots, state);
        derivedIncrements = calculateDerivedIncrements(baseStats, equipInit, equipCurr, playerLevel, tankSettings);
      } else {
      }

      updateStatsDisplay(increments, derivedIncrements);
    }

    function updateStatsDisplay(increments, derivedIncrements) {
      clearPanelIncrementSources('upgrade');
      clearPanelIncrementSources('derived');

      if (Object.keys(increments).length === 0 && Object.keys(derivedIncrements).length === 0) {
        renderPanelIncrements();
        return;
      }
      if (!gEnglishStatsPanel || !getStatsPanelIndex()) {
        renderPanelIncrements();
        return;
      }

      function findMainHandDamageItem() {
        for (const name of ['Crushing Damage', 'Slashing Damage', 'Piercing Damage', 'Void Damage']) {
          const enRow = findEnglishPanelRow('mainhand', name);
          if (!enRow) continue;
          const liveItem = findLiveRowByEnglishRow('mainhand', enRow);
          if (liveItem) return liveItem;
        }
        return null;
      }

      function findMagicDamageItem() {
        const enRow = findEnglishPanelRow('magic', 'Magic Damage');
        if (!enRow) return null;
        return findLiveRowByEnglishRow('magic', enRow);
      }

      const mainHandDamageItem = findMainHandDamageItem();
      const magicDamageItem = findMagicDamageItem();

      const pending = new Map();

      function queueIncrement(item, diff, color, canonicalName) {
        if (!item) return;
        const key = item.tr || item.td2;
        if (!key) return;
        const entry = pending.get(key) || { item, green: 0, blue: 0, canonicalName: '' };
        if (color === 'blue') {
          entry.blue += Number(diff) || 0;
        } else {
          entry.green += Number(diff) || 0;
        }
        const name = String(canonicalName || item.panelName || '');
        if (/Mana Cost/.test(name)) {
          entry.canonicalName = 'Mana Cost';
        } else if (!entry.canonicalName) {
          entry.canonicalName = name;
        }
        pending.set(key, entry);
      }

      for (const [compositeKey, diff] of Object.entries(increments)) {
        const pipeIndex = compositeKey.lastIndexOf('|');
        if (pipeIndex === -1) continue;
        const title = compositeKey.substring(0, pipeIndex);
        const section = DIRECT_STAT_SECTION_MAP[title] || compositeKey.substring(pipeIndex + 1);

        const enRow = findEnglishPanelRow(section, title);
        if (!enRow) continue;
        const liveItem = findLiveRowByEnglishRow(section, enRow);
        queueIncrement(liveItem, diff, 'green', enRow.name);
      }

      for (const [key, value] of Object.entries(derivedIncrements)) {
        const parts = key.split('|');
        if (parts.length !== 2) continue;
        const displayName = parts[0];
        const area = parts[1];

        if (displayName === 'Physical Damage' && area === 'mainhand') {
          queueIncrement(mainHandDamageItem, value, 'blue', 'Damage');
          continue;
        }

        if (displayName === 'Magical Damage' && area === 'magic') {
          queueIncrement(magicDamageItem, value, 'blue', 'Damage Bonus');
          continue;
        }

        const enRow = findEnglishPanelRow(area, displayName);
        if (!enRow) continue;
        const liveItem = findLiveRowByEnglishRow(area, enRow);
        queueIncrement(liveItem, value, 'blue', enRow.name);
      }

      for (const entry of pending.values()) {
        if (Math.abs(entry.green) >= 0.0001) {
          setPanelIncrementSource(entry.item, 'upgrade', normalizePanelDisplayDiff(entry.green, entry.canonicalName));
        }
        if (Math.abs(entry.blue) >= 0.0001) {
          setPanelIncrementSource(entry.item, 'derived', normalizePanelDisplayDiff(entry.blue, entry.canonicalName));
        }
      }

      renderPanelIncrements();
    }

    function restoreOriginalStats() {
      clearPanelIncrementSources('upgrade');
      clearPanelIncrementSources('derived');
      clearPanelIncrementSources('charm');
      renderPanelIncrements();
    }

    applyIncrements(equipSlots, state);
    notifyMaccSimulationChanged();
  }

  const materialCalculator = (() => {
    const CONFIG = {
      IDS: {
        overlay: 'hvmepp-overlay',
        panel: 'hvmepp-panel',
        status: 'hvmepp-status',
        result: 'hvmepp-result',
        inventoryDisplay: 'hvmepp-inventory-display',
        closeBtn: 'hvmepp-close',
        materialSelect: 'hvmepp-material',
        qualitySelect: 'hvmepp-quality',
        rareCheck: 'hvmepp-rare-chk',
        rareSelect: 'hvmepp-rare-select',
        coreSelect: 'hvmepp-core-type',
        currentLvl: 'hvmepp-current-lvl',
        targetLvl: 'hvmepp-target-lvl',
        currentIW: 'hvmepp-current-iw',
        targetIW: 'hvmepp-target-iw',
        maxHint: 'hvmepp-max-hint',
        iwMaxHint: 'hvmepp-iw-max-hint',
        priceSourceSelect: 'hvmepp-price-source',
        refreshPriceBtn: 'hvmepp-refresh-price',
        useCoreDeduction: 'hvmepp-use-core-deduction',
        useInventory: 'hvmepp-use-inventory',
        refreshInventoryBtn: 'hvmepp-refresh-inventory',
      },
      REQUEST_TIMEOUT: 30000,
      MAX_LEVEL: 33,
      MAX_IW: 33,
    };

    const isIsekai = location.pathname.startsWith('/isekai/') || location.href.includes('/isekai/');
    const WORLD_NAME = isIsekai ? '异世界' : '主世界';
    const STORE_KEY = 'hv_equip_upgrade_planner_v2_' + (isIsekai ? 'isekai' : 'main');
    const QUALITY_ORDER = ['上等', '优良', '史诗', '传奇', '无双', '至尊'];
    const MATERIAL_TYPE_MAP = { '布料': 'Cloth', '皮革': 'Leather', '金属': 'Metals', '木材': 'Wood' };
    const RARE_MATERIAL_OPTIONS = {
      '相位碎片': 'Crystallized Phazon',
      '暗影碎片': 'Shade Fragment',
      '动力碎片': 'Repurposed Actuator',
      '力场碎片': 'Defense Matrix Modulator'
    };
    const RARE_BY_MATERIAL = {
      '布料': ['相位碎片'],
      '皮革': ['暗影碎片'],
      '金属': ['动力碎片', '力场碎片'],
      '木材': []
    };
    const CORE_TYPE_OPTIONS = { '武器': 'Weapon', '法杖': 'Staff', '护甲': 'Armor' };
    const CORE_BY_MATERIAL = {
      '布料': ['护甲'], '皮革': ['护甲'], '金属': ['武器', '护甲'], '木材': ['法杖', '护甲']
    };
    const BASE_MATERIAL_NAMES = [
      'Low-Grade Cloth', 'Mid-Grade Cloth', 'High-Grade Cloth',
      'Low-Grade Leather', 'Mid-Grade Leather', 'High-Grade Leather',
      'Low-Grade Metals', 'Mid-Grade Metals', 'High-Grade Metals',
      'Low-Grade Wood', 'Mid-Grade Wood', 'High-Grade Wood'
    ];
    const BASE_MATERIAL_GROUPS = [
      { label: '布料', keys: ['Low-Grade Cloth', 'Mid-Grade Cloth', 'High-Grade Cloth'] },
      { label: '皮革', keys: ['Low-Grade Leather', 'Mid-Grade Leather', 'High-Grade Leather'] },
      { label: '金属', keys: ['Low-Grade Metals', 'Mid-Grade Metals', 'High-Grade Metals'] },
      { label: '木材', keys: ['Low-Grade Wood', 'Mid-Grade Wood', 'High-Grade Wood'] },
    ];
    const RARE_MATERIAL_NAMES = Object.values(RARE_MATERIAL_OPTIONS);
    const CORE_NAMES = [
      'Legendary Weapon Core', 'Peerless Weapon Core',
      'Legendary Staff Core', 'Peerless Staff Core',
      'Legendary Armor Core', 'Peerless Armor Core'
    ];
    const WORLD_SEED_KEY = 'World Seed';
    const SPECIAL_MATERIAL_NAMES = [WORLD_SEED_KEY];
    const MARKET_MATERIAL_NAMES = [...BASE_MATERIAL_NAMES, ...RARE_MATERIAL_NAMES, ...SPECIAL_MATERIAL_NAMES];
    const INVENTORY_MATERIAL_NAMES = [...BASE_MATERIAL_NAMES, ...RARE_MATERIAL_NAMES, ...CORE_NAMES, ...SPECIAL_MATERIAL_NAMES];
    const CORE_FIXED_PRICE = { Legendary: 20000, Peerless: 500000 };
    const PRICE_SOURCE_OPTIONS = [
      ['ask', '卖价 Ask'], ['bid', '买价 Bid'], ['day', '日均价'],
      ['week', '周均价'], ['month', '月均价'], ['year', '年均价'], ['hvut', 'HV Utils 保存价']
    ];
    const HISTORY_PRICE_SOURCES = new Set(['day', 'week', 'month', 'year']);
    const DISPLAY_NAME_MAP = new Map([
      ['Low-Grade Cloth', '低级布料'], ['Mid-Grade Cloth', '中级布料'], ['High-Grade Cloth', '高级布料'],
      ['Low-Grade Leather', '低级皮革'], ['Mid-Grade Leather', '中级皮革'], ['High-Grade Leather', '高级皮革'],
      ['Low-Grade Metals', '低级金属'], ['Mid-Grade Metals', '中级金属'], ['High-Grade Metals', '高级金属'],
      ['Low-Grade Wood', '低级木材'], ['Mid-Grade Wood', '中级木材'], ['High-Grade Wood', '高级木材'],
      ['Crystallized Phazon', '相位碎片'], ['Shade Fragment', '暗影碎片'],
      ['Repurposed Actuator', '动力碎片'], ['Defense Matrix Modulator', '力场碎片'],
      ['Legendary Weapon Core', '传奇武器核心'], ['Peerless Weapon Core', '无双武器核心'],
      ['Legendary Staff Core', '传奇法杖核心'], ['Peerless Staff Core', '无双法杖核心'],
      ['Legendary Armor Core', '传奇护甲核心'], ['Peerless Armor Core', '无双护甲核心'],
      ['World Seed', '世界之种'],
      ['Credits', 'c']
    ]);

    const QUALITY_CONFIG = {
      '上等': {
        maxLevel: 10, needCore: false,
        getReq: level => ({ low: 100, mid: 0, high: 0, rare: level <= 5 ? 1 : 2, legendaryCore: 0, peerlessCore: 0, credits: 1000 })
      },
      '优良': {
        maxLevel: 10, needCore: false,
        getReq: level => ({ low: 100, mid: 0, high: 0, rare: level <= 5 ? 1 : 2, legendaryCore: 0, peerlessCore: 0, credits: 5000 })
      },
      '史诗': {
        maxLevel: 20, needCore: false,
        getReq: level => ({
          low: 100,
          mid: level <= 10 ? level * 5 : 50,
          high: 0,
          rare: level <= 5 ? 1 : level <= 10 ? 2 : level <= 15 ? 3 : 4,
          legendaryCore: 0, peerlessCore: 0,
          credits: level <= 10 ? 10000 : 25000
        })
      },
      '传奇': {
        maxLevel: 25, needCore: true,
        getReq: level => ({
          low: 0, mid: 100,
          high: level <= 5 ? level * 5 : 50,
          rare: level <= 5 ? 1 : level <= 10 ? 2 : level <= 15 ? 3 : level <= 20 ? 4 : 5,
          legendaryCore: level <= 5 ? 1 : level <= 10 ? 2 : level <= 15 ? 3 : level <= 20 ? 4 : 5,
          peerlessCore: 0,
          credits: level <= 10 ? 25000 : level <= 20 ? 50000 : 100000
        })
      },
      '无双': {
        maxLevel: 30, needCore: true,
        getReq: level => ({
          low: 0, mid: 100,
          high: level <= 5 ? level * 5 : level <= 10 ? 30 + (level - 6) * 5 : 50,
          rare: level <= 5 ? 1 : level <= 10 ? 2 : level <= 15 ? 3 : level <= 20 ? 4 : 5,
          legendaryCore: level <= 25 ? (level <= 5 ? 1 : level <= 10 ? 2 : level <= 15 ? 3 : level <= 20 ? 4 : 5) : 0,
          peerlessCore: level <= 25 ? 0 : 5,
          credits: level <= 10 ? 25000 : level <= 20 ? 50000 : 100000
        })
      },
      '至尊': {
        maxLevel: 33, needCore: true,
        getReq: level => ({
          low: 0, mid: 100,
          high: level <= 5 ? level * 5 : level <= 10 ? 30 + (level - 6) * 5 : 50,
          rare: level <= 5 ? 1 : level <= 10 ? 2 : level <= 15 ? 3 : level <= 20 ? 4 : 5,
          legendaryCore: level <= 25 ? (level <= 5 ? 1 : level <= 10 ? 2 : level <= 15 ? 3 : level <= 20 ? 4 : 5) : 0,
          peerlessCore: level <= 25 ? 0 : 5,
          credits: level <= 10 ? 25000 : level <= 20 ? 50000 : 100000
        })
      }
    };

    function getIWMax(quality) {
      return QUALITY_CONFIG[quality]?.maxLevel || CONFIG.MAX_IW;
    }

    function $(selector, root = document) { return root.querySelector(selector); }
    function elt(tag, attrs = {}, children = []) {
      const node = document.createElement(tag);
      Object.entries(attrs).forEach(([key, value]) => {
        if (value === undefined || value === null) return;
        if (key === 'class') node.className = value;
        else if (key === 'style') node.style.cssText = value;
        else if (key === 'text') node.textContent = value;
        else if (key in node) node[key] = value;
        else node.setAttribute(key, value);
      });
      (Array.isArray(children) ? children : [children]).forEach(child => {
        if (child !== null && child !== undefined) node.appendChild(typeof child === 'object' ? child : document.createTextNode(String(child)));
      });
      return node;
    }
    function parseStoredJson(value, fallback = null) {
      if (value === null || value === undefined) return fallback;
      if (typeof value === 'string') {
        try { return JSON.parse(value); } catch (e) { return fallback; }
      }
      return value;
    }
    function isPlainObject(value) { return value && typeof value === 'object' && !Array.isArray(value); }
    function gmGet(key, fallback) {
      try {
        const value = typeof GM_getValue === 'function' ? GM_getValue(key, null) : localStorage.getItem(key);
        return parseStoredJson(value, fallback);
      } catch (e) { return fallback; }
    }
    function gmSet(key, value) {
      try {
        if (typeof GM_setValue === 'function') GM_setValue(key, JSON.stringify(value));
        else localStorage.setItem(key, JSON.stringify(value));
      } catch (e) {}
    }
    function readHvUtilsPrices() {
      try {
        if (typeof GM_getValue === 'function') {
          const value = parseStoredJson(GM_getValue('hvut_prices', null));
          if (isPlainObject(value)) return value;
        }
      } catch (e) {}
      try {
        const value = parseStoredJson(localStorage.getItem('hvut_prices'));
        return isPlainObject(value) ? value : {};
      } catch (e) { return {}; }
    }
    function writeHvUtilsPrices(patch) {
      const prices = Object.assign({}, readHvUtilsPrices(), patch);
      try { if (typeof GM_setValue === 'function') GM_setValue('hvut_prices', prices); } catch (e) {}
      try { localStorage.setItem('hvut_prices', JSON.stringify(prices)); } catch (e) {}
    }
    function parseNum(text) {
      const match = String(text || '').replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
      return match ? Number(match[0]) : NaN;
    }
    function positiveNumber(value) {
      const number = Number(value);
      return Number.isFinite(number) && number > 0 ? number : 0;
    }
    function clampInt(value, min, max) {
      const number = parseInt(value, 10);
      return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : min;
    }
    function getDisplayName(key) { return DISPLAY_NAME_MAP.get(key) || key; }
    function formatNumber(value) { return Number.isInteger(value) ? String(value) : Number(value).toFixed(2); }
    function formatPrice(value) {
      return value > 0 ? value.toFixed(2).replace(/\.?0+$/, '') + ' c' : '无数据';
    }
    function formatMoney(value) {
      if (!Number.isFinite(value)) return '无数据';
      if (value === 0) return '0 c';
      const abs = Math.abs(value);
      const sign = value < 0 ? '-' : '';
      if (abs >= 1000000) return sign + (abs / 1000000).toFixed(1) + ' Mc';
      if (abs >= 1000) return sign + (abs / 1000).toFixed(1) + ' Kc';
      return sign + (Number.isInteger(abs) ? abs : abs.toFixed(1)) + ' c';
    }

    const savedState = gmGet(STORE_KEY, {});
    const plannerState = Object.assign({
      materialType: '布料', useRare: false, rareMaterial: '相位碎片', coreType: '护甲', quality: '上等',
      currentLevel: 0, targetLevel: 10, currentIW: 0, targetIW: 0, useCoreDeduction: true, useInventory: false,
      priceSource: 'hvut', inventory: {}, inventoryLastUpdate: 0
    }, isPlainObject(savedState) ? savedState : {});
    if (savedState && savedState.useInventoryCore !== undefined) plannerState.useInventory = savedState.useInventoryCore;
    if (savedState && savedState.coreInventory !== undefined) plannerState.inventory = savedState.coreInventory;
    if (savedState && savedState.includeCoreCost !== undefined) plannerState.useCoreDeduction = savedState.includeCoreCost;
    if (!isPlainObject(plannerState.inventory)) plannerState.inventory = {};
    INVENTORY_MATERIAL_NAMES.forEach(name => {
      if (plannerState.inventory[name] === undefined) plannerState.inventory[name] = 0;
    });
    if (!PRICE_SOURCE_OPTIONS.some(([value]) => value === plannerState.priceSource)) plannerState.priceSource = 'hvut';
    if (!MATERIAL_TYPE_MAP[plannerState.materialType]) plannerState.materialType = '布料';
    if (typeof plannerState.rareMaterial === 'string' && plannerState.rareMaterial.includes('(')) plannerState.rareMaterial = plannerState.rareMaterial.split('(')[0].trim();
    if (!CORE_TYPE_OPTIONS[plannerState.coreType]) plannerState.coreType = '护甲';
    if (!QUALITY_CONFIG[plannerState.quality] || (isIsekai && plannerState.quality === '至尊')) plannerState.quality = '上等';
    plannerState.currentLevel = clampInt(plannerState.currentLevel, 0, CONFIG.MAX_LEVEL);
    plannerState.targetLevel = clampInt(plannerState.targetLevel, 0, CONFIG.MAX_LEVEL);
    const initialIWMax = getIWMax(plannerState.quality);
    plannerState.currentIW = clampInt(plannerState.currentIW, 0, initialIWMax);
    plannerState.targetIW = clampInt(plannerState.targetIW, 0, initialIWMax);

    function saveState() { gmSet(STORE_KEY, plannerState); }
    function getAvailableQualities() { return QUALITY_ORDER.filter(q => !(isIsekai && q === '至尊')); }
    function validateMaterialOptions() {
      const rareOptions = RARE_BY_MATERIAL[plannerState.materialType] || [];
      if (!rareOptions.includes(plannerState.rareMaterial)) plannerState.rareMaterial = rareOptions[0] || '';
      const coreOptions = CORE_BY_MATERIAL[plannerState.materialType] || [];
      if (!coreOptions.includes(plannerState.coreType)) plannerState.coreType = coreOptions[0] || '护甲';
      if (!rareOptions.length) plannerState.useRare = false;
    }

    function normalizeForgeIWState() {
      const iwMax = getIWMax(plannerState.quality);
      plannerState.currentIW = clampInt(plannerState.currentIW, 0, iwMax);
      plannerState.targetIW = clampInt(plannerState.targetIW, 0, iwMax);
      if (plannerState.currentLevel <= iwMax && plannerState.currentLevel > plannerState.currentIW) {
        plannerState.currentIW = plannerState.currentLevel;
      }
      if (plannerState.targetLevel <= iwMax && plannerState.targetLevel > plannerState.targetIW) {
        plannerState.targetIW = plannerState.targetLevel;
      }
    }

    validateMaterialOptions();
    normalizeForgeIWState();

    function getWorldSeedPerLevel(quality) {
      if (quality === '上等' || quality === '优良') return 1;
      if (quality === '史诗') return 2;
      return 3;
    }

    function calculateUpgradeFor(options = {}) {
      const settings = Object.assign({}, plannerState, options);
      const matType = settings.materialType;
      const quality = settings.quality;
      const config = QUALITY_CONFIG[quality];
      const fromLvl = clampInt(settings.currentLevel, 0, CONFIG.MAX_LEVEL);
      const toLvl = clampInt(settings.targetLevel, 0, CONFIG.MAX_LEVEL);
      const iwMax = getIWMax(quality);
      const fromIW = Math.max(clampInt(settings.currentIW, 0, iwMax), fromLvl);
      const toIW = Math.max(clampInt(settings.targetIW, 0, iwMax), toLvl);
      if (toLvl < fromLvl) return { ok: false, message: '目标锻造等级不能低于当前锻造等级。' };
      if (toIW < fromIW) return { ok: false, message: '目标 IW 等级不能低于当前 IW 等级。' };
      if (fromLvl === toLvl && fromIW === toIW) return { ok: false, message: '目标等级必须高于当前锻造等级或当前 IW 等级。' };
      if (!config) return { ok: false, message: '未知品质配置。' };
      if (toLvl > config.maxLevel) return { ok: false, message: `${quality}品质最高支持强化到${config.maxLevel}级。` };
      const baseMatType = MATERIAL_TYPE_MAP[matType] || 'Cloth';
      const lowKey = `Low-Grade ${baseMatType}`;
      const midKey = `Mid-Grade ${baseMatType}`;
      const highKey = `High-Grade ${baseMatType}`;
      const rareOptions = RARE_BY_MATERIAL[matType] || [];
      const useRare = Boolean(settings.useRare && rareOptions.length);
      const rareDisplayName = useRare && rareOptions.includes(settings.rareMaterial) ? settings.rareMaterial : (useRare ? rareOptions[0] : null);
      const rareKey = rareDisplayName ? RARE_MATERIAL_OPTIONS[rareDisplayName] : null;
      const corePrefix = CORE_TYPE_OPTIONS[settings.coreType] || 'Armor';
      const legendCoreKey = `Legendary ${corePrefix} Core`;
      const peerlessCoreKey = `Peerless ${corePrefix} Core`;
      const worldSeedPerLevel = getWorldSeedPerLevel(quality);
      const worldSeedTotal = (toIW - fromIW) * worldSeedPerLevel;
      const totals = { low: 0, mid: 0, high: 0, rare: 0, legendaryCore: 0, peerlessCore: 0, credits: 0, worldSeed: worldSeedTotal };
      const materialTotals = { [lowKey]: 0, [midKey]: 0, [highKey]: 0, [legendCoreKey]: 0, [peerlessCoreKey]: 0, [WORLD_SEED_KEY]: worldSeedTotal };
      if (rareKey) materialTotals[rareKey] = 0;
      const breakdown = [];
      for (let level = fromLvl + 1; level <= toLvl; level++) {
        const req = config.getReq(level);
        totals.low += req.low; totals.mid += req.mid; totals.high += req.high;
        totals.rare += useRare ? req.rare : 0;
        totals.legendaryCore += req.legendaryCore;
        totals.peerlessCore += req.peerlessCore;
        totals.credits += req.credits;
        materialTotals[lowKey] += req.low;
        materialTotals[midKey] += req.mid;
        materialTotals[highKey] += req.high;
        if (rareKey) materialTotals[rareKey] += useRare ? req.rare : 0;
        materialTotals[legendCoreKey] += req.legendaryCore;
        materialTotals[peerlessCoreKey] += req.peerlessCore;
        breakdown.push({ level, low: req.low, mid: req.mid, high: req.high, rare: useRare ? req.rare : 0, worldSeed: 0, legendaryCore: req.legendaryCore, peerlessCore: req.peerlessCore, credits: req.credits });
      }
      const iwBreakdown = [];
      for (let level = fromIW + 1; level <= toIW; level++) iwBreakdown.push({ level, worldSeed: worldSeedPerLevel });
      const prices = readHvUtilsPrices();
      const lowPrice = positiveNumber(prices[lowKey]);
      const midPrice = positiveNumber(prices[midKey]);
      const highPrice = positiveNumber(prices[highKey]);
      const rarePrice = rareKey ? positiveNumber(prices[rareKey]) : 0;
      const worldSeedPrice = positiveNumber(prices[WORLD_SEED_KEY]);
      const legendCorePrice = settings.useCoreDeduction ? (positiveNumber(prices[legendCoreKey]) || CORE_FIXED_PRICE.Legendary) : CORE_FIXED_PRICE.Legendary;
      const peerlessCorePrice = settings.useCoreDeduction ? (positiveNumber(prices[peerlessCoreKey]) || CORE_FIXED_PRICE.Peerless) : CORE_FIXED_PRICE.Peerless;
      const rawMaterialCost = totals.low * lowPrice + totals.mid * midPrice + totals.high * highPrice + totals.rare * rarePrice + worldSeedTotal * worldSeedPrice;
      const rawCoreCost = totals.legendaryCore * legendCorePrice + totals.peerlessCore * peerlessCorePrice;
      const useInventory = Boolean(settings.useInventory);
      const inventory = settings.inventory || {};
      const held = key => useInventory ? Math.max(0, Number(inventory[key]) || 0) : 0;
      const need = (key, amount) => Math.max(0, amount - held(key));
      const needBuyLow = need(lowKey, totals.low);
      const needBuyMid = need(midKey, totals.mid);
      const needBuyHigh = need(highKey, totals.high);
      const needBuyRare = rareKey ? need(rareKey, totals.rare) : 0;
      const needBuyWorldSeed = need(WORLD_SEED_KEY, worldSeedTotal);
      const needBuyLegendary = need(legendCoreKey, totals.legendaryCore);
      const needBuyPeerless = need(peerlessCoreKey, totals.peerlessCore);
      const materialCost = needBuyLow * lowPrice + needBuyMid * midPrice + needBuyHigh * highPrice + needBuyRare * rarePrice + needBuyWorldSeed * worldSeedPrice;
      const coreCashCost = needBuyLegendary * legendCorePrice + needBuyPeerless * peerlessCorePrice;
      return {
        ok: true, fromLvl, toLvl, fromIW, toIW, quality, matType, useRare, rareDisplayName, rareKey, coreType: settings.coreType,
        totals, materialTotals, breakdown, iwBreakdown, lowKey, midKey, highKey, legendCoreKey, peerlessCoreKey,
        worldSeedKey: WORLD_SEED_KEY, worldSeedPerLevel, worldSeedTotal,
        lowPrice, midPrice, highPrice, rarePrice, worldSeedPrice, legendCorePrice, peerlessCorePrice,
        rawMaterialCost, rawCoreCost, materialCost, coreCashCost, creditsCost: totals.credits,
        totalCost: materialCost + coreCashCost + totals.credits, useCoreDeduction: Boolean(settings.useCoreDeduction),
        useInventory, held: {
          [lowKey]: held(lowKey), [midKey]: held(midKey), [highKey]: held(highKey),
          ...(rareKey ? { [rareKey]: held(rareKey) } : {}),
          [WORLD_SEED_KEY]: held(WORLD_SEED_KEY),
          [legendCoreKey]: held(legendCoreKey), [peerlessCoreKey]: held(peerlessCoreKey)
        },
        needBuy: { [lowKey]: needBuyLow, [midKey]: needBuyMid, [highKey]: needBuyHigh, ...(rareKey ? { [rareKey]: needBuyRare } : {}), [WORLD_SEED_KEY]: needBuyWorldSeed, [legendCoreKey]: needBuyLegendary, [peerlessCoreKey]: needBuyPeerless }
      };
    }

    function setStatus(text) {
      const node = $(`#${CONFIG.IDS.status}`);
      if (node) node.textContent = text || '';
    }
    function getInventoryDisplayText() {
      const amount = name => plannerState.inventory[name] || 0;
      const base = BASE_MATERIAL_GROUPS.map(group => {
        const [low, mid, high] = group.keys;
        return `${group.label} | 低:${amount(low)} 中:${amount(mid)} 高:${amount(high)}`;
      });
      const rare = RARE_MATERIAL_NAMES.map(name => {
        const shortName = getDisplayName(name).replace(/碎片$/, '');
        return `${shortName}:${amount(name)}`;
      });
      const cores = CORE_NAMES.map(name => {
        const shortName = getDisplayName(name)
          .replace(/^传奇法杖核心$/, 'L法杖')
          .replace(/^无双法杖核心$/, 'P法杖')
          .replace(/^传奇武器核心$/, 'L武器')
          .replace(/^无双武器核心$/, 'P武器')
          .replace(/^传奇护甲核心$/, 'L护甲')
          .replace(/^无双护甲核心$/, 'P护甲');
        return `${shortName}:${amount(name)}`;
      });
      const special = SPECIAL_MATERIAL_NAMES.map(name => `${getDisplayName(name)}:${amount(name)}`);
      return [
        ...base,
        `稀有 | ${rare.join(' ')}`,
        `核心 | ${cores.join(' ')}`,
        `特殊 | ${special.join(' ')}`,
      ].join('\n');
    }
    function updateInventoryDisplayNode(node) {
      if (node) node.textContent = getInventoryDisplayText();
    }
    function updateInventoryDisplay() {
      const text = getInventoryDisplayText();
      document.querySelectorAll(`#${CONFIG.IDS.inventoryDisplay}, .hvmepp-plan-inventory-display`).forEach(node => {
        node.textContent = text;
      });
    }
    function fetchAllInventory() {
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: 'GET', url: (isIsekai ? 'https://hentaiverse.org/isekai/' : 'https://hentaiverse.org/') + '?s=Character&ss=it', timeout: CONFIG.REQUEST_TIMEOUT,
          onload: response => {
            if (response.status < 200 || response.status >= 300) { reject(new Error('HTTP ' + response.status)); return; }
            const doc = new DOMParser().parseFromString(response.responseText, 'text/html');
            const inventory = {};
            INVENTORY_MATERIAL_NAMES.forEach(name => inventory[name] = 0);
            const table = doc.querySelector('#inv_item .itemlist');
            if (table) table.querySelectorAll('tr').forEach(row => {
              const name = row.querySelector('td:first-child div')?.textContent.trim();
              const qty = parseInt(row.querySelector('td:last-child')?.textContent.replace(/,/g, ''), 10);
              if (name && Object.prototype.hasOwnProperty.call(inventory, name) && Number.isFinite(qty)) inventory[name] = qty;
            });
            resolve(inventory);
          },
          onerror: () => reject(new Error('请求失败')),
          ontimeout: () => reject(new Error('请求超时'))
        });
      });
    }
    async function refreshInventory(button, after) {
      if (button) { button.disabled = true; button.textContent = '读取中…'; }
      setStatus('正在读取库存…');
      try {
        plannerState.inventory = await fetchAllInventory();
        plannerState.inventoryLastUpdate = Date.now();
        saveState();
        updateInventoryDisplay();
        setStatus('库存读取完成');
        showToast('库存读取完成');
        if (after) after(); else calculate();
      } catch (error) {
        setStatus('读取库存失败: ' + error.message);
      } finally {
        if (button) { button.disabled = false; button.textContent = '刷新库存数量'; }
      }
    }
    function getBaseUrl() { return isIsekai ? 'https://hentaiverse.org/isekai/' : 'https://hentaiverse.org/'; }
    function fetchMarketData() {
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: 'GET', url: getBaseUrl() + '?s=Bazaar&ss=mk&screen=browseitems&filter=ma', timeout: CONFIG.REQUEST_TIMEOUT,
          onload: response => {
            if (response.status < 200 || response.status >= 300) { reject(new Error('HTTP ' + response.status)); return; }
            const doc = new DOMParser().parseFromString(response.responseText, 'text/html');
            const table = doc.querySelector('#market_itemlist table');
            const result = {};
            if (!table) { resolve(result); return; }
            const headers = Array.from(table.rows[0]?.cells || []).map(cell => cell.textContent.trim().replace(/\s+/g, ' '));
            const columns = Object.fromEntries(headers.map((name, index) => [name, index]));
            const nameCol = columns.Item ?? 0;
            for (let index = 1; index < table.rows.length; index++) {
              const row = table.rows[index];
              const name = row.cells[nameCol]?.textContent.trim();
              if (!MARKET_MATERIAL_NAMES.includes(name)) continue;
              const itemId = (row.getAttribute('onclick') || '').match(/itemid=(\d+)/)?.[1] || null;
              result[name] = {
                itemid: itemId,
                bid: columns['Market Bid'] === undefined ? NaN : parseNum(row.cells[columns['Market Bid']]?.textContent),
                ask: columns['Market Ask'] === undefined ? NaN : parseNum(row.cells[columns['Market Ask']]?.textContent)
              };
            }
            resolve(result);
          },
          onerror: () => reject(new Error('请求失败')),
          ontimeout: () => reject(new Error('请求超时'))
        });
      });
    }
    function fetchMarketHistory(itemId) {
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: 'GET', url: getBaseUrl() + `?s=Bazaar&ss=mk&itemid=${encodeURIComponent(itemId)}`, timeout: CONFIG.REQUEST_TIMEOUT,
          onload: response => {
            if (response.status < 200 || response.status >= 300) { reject(new Error('HTTP ' + response.status)); return; }
            const doc = new DOMParser().parseFromString(response.responseText, 'text/html');
            const rows = doc.querySelector('#market_price')?.rows || [];
            const average = index => parseNum(rows[index]?.cells?.[3]?.textContent) || 0;
            resolve({ day: average(1), week: average(2), month: average(3), year: average(4) });
          },
          onerror: () => reject(new Error('请求失败')),
          ontimeout: () => reject(new Error('请求超时'))
        });
      });
    }
    async function refreshPrices(source, button) {
      if (button) { button.disabled = true; button.textContent = '读取中…'; }
      setStatus('正在读取价格…');
      try {
        if (source === 'hvut') {
          const count = Object.keys(readHvUtilsPrices()).filter(key => MARKET_MATERIAL_NAMES.includes(key)).length;
          setStatus(`HV Utils 保存价已读取：${count} 种材料`);
          calculate();
          return;
        }
        const market = await fetchMarketData();
        const patch = {};
        if (source === 'ask' || source === 'bid') {
          Object.entries(market).forEach(([name, data]) => {
            const price = source === 'ask' ? data.ask : data.bid;
            if (price > 0) patch[name] = price;
          });
        } else if (HISTORY_PRICE_SOURCES.has(source)) {
          const entries = Object.entries(market).filter(([, data]) => data.itemid);
          await Promise.all(entries.map(async ([name, data]) => {
            try {
              const history = await fetchMarketHistory(data.itemid);
              if (history[source] > 0) patch[name] = history[source];
            } catch (e) {}
          }));
        }
        writeHvUtilsPrices(patch);
        setStatus(`价格已更新：${Object.keys(patch).length} 种材料`);
        showToast('价格更新完成');
        calculate();
      } catch (error) {
        setStatus('读取价格失败: ' + error.message);
      } finally {
        if (button) { button.disabled = false; button.textContent = '刷新市场价格'; }
      }
    }

    function updateRareOptions() {
      const rareSelect = $(`#${CONFIG.IDS.rareSelect}`);
      const rareCheck = $(`#${CONFIG.IDS.rareCheck}`);
      if (!rareSelect || !rareCheck) return;
      const available = RARE_BY_MATERIAL[plannerState.materialType] || [];
      rareSelect.replaceChildren();
      available.forEach(name => rareSelect.appendChild(elt('option', { value: name, text: name })));
      if (!available.includes(plannerState.rareMaterial)) plannerState.rareMaterial = available[0] || '';
      const enabled = available.length > 0;
      rareCheck.disabled = !enabled;
      rareSelect.disabled = !enabled || !plannerState.useRare;
      rareSelect.style.opacity = rareSelect.disabled ? '0.5' : '1';
      if (!enabled) plannerState.useRare = false;
      rareCheck.checked = plannerState.useRare;
      if (plannerState.rareMaterial) rareSelect.value = plannerState.rareMaterial;
    }
    function updateCoreOptions() {
      const coreSelect = $(`#${CONFIG.IDS.coreSelect}`);
      if (!coreSelect) return;
      const available = CORE_BY_MATERIAL[plannerState.materialType] || [];
      coreSelect.replaceChildren();
      available.forEach(name => coreSelect.appendChild(elt('option', { value: name, text: name })));
      if (!available.includes(plannerState.coreType)) plannerState.coreType = available[0] || '护甲';
      const needCore = Boolean(QUALITY_CONFIG[plannerState.quality]?.needCore);
      coreSelect.disabled = !needCore;
      coreSelect.style.opacity = needCore ? '1' : '0.5';
      if (plannerState.coreType) coreSelect.value = plannerState.coreType;
    }
    function updateTargetMax() {
      const maxLevel = QUALITY_CONFIG[plannerState.quality]?.maxLevel || 10;
      const maxIW = getIWMax(plannerState.quality);
      plannerState.targetLevel = clampInt(plannerState.targetLevel, 0, maxLevel);
      const target = $(`#${CONFIG.IDS.targetLvl}`);
      if (target) {
        target.max = maxLevel;
        if (parseInt(target.value, 10) > maxLevel) target.value = maxLevel;
      }
      const hint = $(`#${CONFIG.IDS.maxHint}`);
      if (hint) hint.textContent = `(最高 ${maxLevel} 级)`;
      const targetIW = $(`#${CONFIG.IDS.targetIW}`);
      if (targetIW) {
        targetIW.max = maxIW;
        if (parseInt(targetIW.value, 10) > maxIW) targetIW.value = maxIW;
      }
      const currentIW = $(`#${CONFIG.IDS.currentIW}`);
      if (currentIW) {
        currentIW.max = maxIW;
        if (parseInt(currentIW.value, 10) > maxIW) currentIW.value = maxIW;
      }
      const iwHint = $(`#${CONFIG.IDS.iwMaxHint}`);
      if (iwHint) iwHint.textContent = `(最高 IW${maxIW})`;
    }
    function readUI() {
      const ids = CONFIG.IDS;
      const material = $(`#${ids.materialSelect}`);
      const quality = $(`#${ids.qualitySelect}`);
      const rareCheck = $(`#${ids.rareCheck}`);
      const rare = $(`#${ids.rareSelect}`);
      const core = $(`#${ids.coreSelect}`);
      const current = $(`#${ids.currentLvl}`);
      const target = $(`#${ids.targetLvl}`);
      const currentIW = $(`#${ids.currentIW}`);
      const targetIW = $(`#${ids.targetIW}`);
      const coreDeduction = $(`#${ids.useCoreDeduction}`);
      const inventory = $(`#${ids.useInventory}`);
      const priceSource = $(`#${ids.priceSourceSelect}`);
      if (material) plannerState.materialType = material.value;
      if (quality && getAvailableQualities().includes(quality.value)) plannerState.quality = quality.value;
      if (rareCheck) plannerState.useRare = rareCheck.checked;
      if (rare) plannerState.rareMaterial = rare.value;
      if (core) plannerState.coreType = core.value;
      if (current) plannerState.currentLevel = clampInt(current.value, 0, CONFIG.MAX_LEVEL);
      if (target) {
        const maxLevel = QUALITY_CONFIG[plannerState.quality]?.maxLevel || CONFIG.MAX_LEVEL;
        plannerState.targetLevel = clampInt(target.value, 0, maxLevel);
      }
      const iwMax = getIWMax(plannerState.quality);
      if (currentIW) plannerState.currentIW = clampInt(currentIW.value, 0, iwMax);
      if (targetIW) plannerState.targetIW = clampInt(targetIW.value, 0, iwMax);
      if (coreDeduction) plannerState.useCoreDeduction = coreDeduction.checked;
      if (inventory) plannerState.useInventory = inventory.checked;
      if (priceSource) plannerState.priceSource = priceSource.value;
      validateMaterialOptions();
      normalizeForgeIWState();
      saveState();
    }
    function syncUI() {
      const ids = CONFIG.IDS;
      const material = $(`#${ids.materialSelect}`);
      const quality = $(`#${ids.qualitySelect}`);
      const rareCheck = $(`#${ids.rareCheck}`);
      const rare = $(`#${ids.rareSelect}`);
      const core = $(`#${ids.coreSelect}`);
      const current = $(`#${ids.currentLvl}`);
      const target = $(`#${ids.targetLvl}`);
      const currentIW = $(`#${ids.currentIW}`);
      const targetIW = $(`#${ids.targetIW}`);
      const coreDeduction = $(`#${ids.useCoreDeduction}`);
      const inventory = $(`#${ids.useInventory}`);
      const priceSource = $(`#${ids.priceSourceSelect}`);
      if (material) material.value = plannerState.materialType;
      if (quality) {
        quality.replaceChildren();
        getAvailableQualities().forEach(name => quality.appendChild(elt('option', { value: name, text: name })));
        quality.value = plannerState.quality;
      }
      updateRareOptions();
      updateCoreOptions();
      if (rareCheck) rareCheck.checked = plannerState.useRare;
      if (rare && plannerState.rareMaterial) rare.value = plannerState.rareMaterial;
      if (core) core.value = plannerState.coreType;
      if (current) current.value = plannerState.currentLevel;
      if (target) target.value = plannerState.targetLevel;
      normalizeForgeIWState();
      if (currentIW) currentIW.value = plannerState.currentIW;
      if (targetIW) targetIW.value = plannerState.targetIW;
      if (coreDeduction) coreDeduction.checked = plannerState.useCoreDeduction;
      if (inventory) inventory.checked = plannerState.useInventory;
      if (priceSource) priceSource.value = plannerState.priceSource;
      updateTargetMax();
      updateInventoryDisplay();
      saveState();
    }
    function appendResultRow(table, cells) {
      table.appendChild(elt('tr', {}, cells.map(value => elt('td', { text: String(value) }))));
    }
    function renderResult(result) {
      const box = $(`#${CONFIG.IDS.result}`);
      if (!box) return;
      box.replaceChildren();
      if (!result.ok) {
        box.appendChild(elt('div', { class: 'hvmepp-alert', text: result.message }));
        return;
      }
      const total = elt('div', { class: 'hvmepp-total' }, [
        '总强化成本：', elt('span', { class: 'hvmepp-good', text: formatMoney(result.totalCost) }),
        `（材料 ${formatMoney(result.materialCost)} + 核心 ${formatMoney(result.coreCashCost)} + 基础c ${formatMoney(result.creditsCost)}）`
      ]);
      box.appendChild(total);
      const table = elt('table', { class: 'hvmepp-table' });
      table.appendChild(elt('tr', {}, ['材料类型', '总需求', '库存', '需购买', '单价', '小计'].map(text => elt('th', { text }))));
      const rows = Object.entries(result.materialTotals).filter(([, qty]) => qty > 0).map(([key, totalQty]) => {
        const price = key === result.legendCoreKey ? result.legendCorePrice : key === result.peerlessCoreKey ? result.peerlessCorePrice : positiveNumber(readHvUtilsPrices()[key]);
        const held = result.useInventory ? formatNumber(result.held[key] || 0) : '不使用';
        const needBuy = result.needBuy[key] ?? totalQty;
        return [getDisplayName(key), formatNumber(totalQty), held, formatNumber(needBuy), formatPrice(price), formatMoney(needBuy * price)];
      });
      rows.push(['基础 c', formatNumber(result.creditsCost), '-', formatNumber(result.creditsCost), '-', formatMoney(result.creditsCost)]);
      rows.forEach(row => appendResultRow(table, row));
      box.appendChild(table);
      const detailButton = elt('button', { text: '显示/隐藏逐级明细' });
      const detail = elt('div', { style: 'display:none; max-height:220px; overflow:auto; margin-top:6px;' });
      detailButton.addEventListener('click', () => {
        if (!detail.firstChild) {
          const detailTable = elt('table', { class: 'hvmepp-table' });
          detailTable.appendChild(elt('tr', {}, ['等级', '低级', '中级', '高级', '稀有', '世界之种', '传奇核心', '无双核心', 'c'].map(text => elt('th', { text }))));
          result.breakdown.forEach(row => appendResultRow(detailTable, [row.level, row.low, row.mid, row.high, row.rare, row.worldSeed || 0, row.legendaryCore, row.peerlessCore, formatMoney(row.credits)]));
          result.iwBreakdown.forEach(row => appendResultRow(detailTable, [`IW${row.level}`, 0, 0, 0, 0, row.worldSeed, 0, 0, '-']));
          detail.appendChild(detailTable);
        }
        detail.style.display = detail.style.display === 'none' ? 'block' : 'none';
      });
      box.append(detailButton, detail);
    }
    function calculate() {
      readUI();
      syncUI();
      const result = calculateUpgradeFor();
      renderResult(result);
      const iwText = plannerState.currentIW !== plannerState.targetIW ? `，IW${plannerState.currentIW} → IW${plannerState.targetIW}` : '';
      setStatus(result.ok ? `计算完成：${plannerState.quality} 锻${plannerState.currentLevel} → 锻${plannerState.targetLevel}${iwText}，总成本 ${formatMoney(result.totalCost)}` : result.message);
    }

    function splitPanelScrollable(panel) {
      const children = Array.from(panel.children || []);
      const titleIndex = children.findIndex(child => child.classList?.contains('hvmepp-title'));
      if (titleIndex < 0 || children.length < 2) return;
      const title = children[titleIndex];
      const body = document.createElement('div');
      body.className = 'hvmepp-scroll';
      children.forEach((child, index) => {
        if (index !== titleIndex) body.appendChild(child);
      });
      panel.replaceChildren(title, body);
    }

    let panelElements = null;
    function buildPanel() {
      const overlay = elt('div', { id: CONFIG.IDS.overlay });
      const panel = elt('div', { id: CONFIG.IDS.panel });
      overlay.appendChild(panel);
      const closeButton = elt('button', {
        id: CONFIG.IDS.closeBtn,
        type: 'button',
        class: 'hvmepp-close',
        text: '×',
        title: '关闭',
        'aria-label': '关闭'
      });
      const title = elt('div', { class: 'hvmepp-title' }, [elt('span', { text: `⚒ 装备强化材料模拟（${WORLD_NAME}）` }), closeButton]);
      makeDraggable(overlay, title);
      const row1 = elt('div', { class: 'hvmepp-controls' });
      const material = elt('select', { id: CONFIG.IDS.materialSelect });
      Object.keys(MATERIAL_TYPE_MAP).forEach(name => material.appendChild(elt('option', { value: name, text: name })));
      const quality = elt('select', { id: CONFIG.IDS.qualitySelect });
      const rareCheck = elt('input', { id: CONFIG.IDS.rareCheck, type: 'checkbox' });
      const rare = elt('select', { id: CONFIG.IDS.rareSelect });
      const core = elt('select', { id: CONFIG.IDS.coreSelect });
      const current = elt('input', { id: CONFIG.IDS.currentLvl, type: 'number', min: 0, max: CONFIG.MAX_LEVEL, style: 'width:50px;' });
      const target = elt('input', { id: CONFIG.IDS.targetLvl, type: 'number', min: 0, max: CONFIG.MAX_LEVEL, style: 'width:50px;' });
      const maxHint = elt('span', { id: CONFIG.IDS.maxHint, style: 'color:#666;font-size:9pt;' });
      row1.append(
        elt('label', {}, ['材料 ', material]), elt('label', {}, ['品质 ', quality]),
        elt('label', {}, [rareCheck, ' 稀有材料']), rare, elt('label', {}, ['核心 ', core]),
        elt('label', {}, ['当前锻造 ', current]), elt('label', {}, ['目标锻造 ', target, ' ', maxHint])
      );
      const rowIW = elt('div', { class: 'hvmepp-controls' });
      const currentIW = elt('input', { id: CONFIG.IDS.currentIW, type: 'number', min: 0, max: CONFIG.MAX_IW, style: 'width:50px;' });
      const targetIW = elt('input', { id: CONFIG.IDS.targetIW, type: 'number', min: 0, max: CONFIG.MAX_IW, style: 'width:50px;' });
      const iwMaxHint = elt('span', { id: CONFIG.IDS.iwMaxHint, style: 'color:#666;font-size:9pt;' });
      rowIW.append(
        elt('label', {}, ['当前 IW ', currentIW]),
        elt('label', {}, ['目标 IW ', targetIW, ' ', iwMaxHint])
      );
      const row2 = elt('div', { class: 'hvmepp-controls' });
      const coreDeduction = elt('input', { id: CONFIG.IDS.useCoreDeduction, type: 'checkbox' });
      const inventory = elt('input', { id: CONFIG.IDS.useInventory, type: 'checkbox' });
      const priceSource = elt('select', { id: CONFIG.IDS.priceSourceSelect });
      PRICE_SOURCE_OPTIONS.forEach(([value, text]) => priceSource.appendChild(elt('option', { value, text })));
      const refreshPrice = elt('button', { id: CONFIG.IDS.refreshPriceBtn, text: '刷新市场价格' });
      const refreshInventoryButton = elt('button', { id: CONFIG.IDS.refreshInventoryBtn, text: '刷新库存数量' });
      row2.append(
        elt('label', {}, [coreDeduction, ' 核心按市场价']), elt('label', {}, [inventory, ' 使用库存强化']),
        elt('label', {}, ['价格来源 ', priceSource]), refreshPrice, refreshInventoryButton
      );
      const inventoryDisplay = elt('div', { id: CONFIG.IDS.inventoryDisplay, style: 'font-size:9pt;color:#555;margin:4px 0;padding:4px 8px;background:#f8f6ee;border:1px solid #ddd;white-space:pre-wrap;' });
      const status = elt('div', { id: CONFIG.IDS.status, class: 'hvmepp-plan-note' });
      const result = elt('div', { id: CONFIG.IDS.result });
      panel.append(title, row1, rowIW, row2, status, inventoryDisplay, result);
      splitPanelScrollable(panel);
      return { overlay, material, quality, rareCheck, rare, core, current, target, currentIW, targetIW, coreDeduction, inventory, priceSource, refreshPrice, refreshInventoryButton };
    }
    function bindPanelEvents(elements) {
      const { overlay, material, quality, rareCheck, rare, core, current, target, currentIW, targetIW, coreDeduction, inventory, priceSource, refreshPrice, refreshInventoryButton } = elements;
      overlay.querySelector(`#${CONFIG.IDS.closeBtn}`).addEventListener('click', () => overlay.classList.add('hvmepp-hidden'));
      const changed = () => calculate();
      material.addEventListener('change', () => { readUI(); validateMaterialOptions(); syncUI(); calculate(); });
      quality.addEventListener('change', changed);
      rareCheck.addEventListener('change', changed);
      rare.addEventListener('change', changed);
      core.addEventListener('change', changed);
      current.addEventListener('change', changed);
      target.addEventListener('change', changed);
      currentIW.addEventListener('change', changed);
      targetIW.addEventListener('change', changed);
      coreDeduction.addEventListener('change', changed);
      inventory.addEventListener('change', changed);
      priceSource.addEventListener('change', changed);
      refreshPrice.addEventListener('click', () => refreshPrices(plannerState.priceSource, refreshPrice));
      refreshInventoryButton.addEventListener('click', () => refreshInventory(refreshInventoryButton));
    }
    function renderPanel() {
      let overlay = $(`#${CONFIG.IDS.overlay}`);
      if (overlay) {
        overlay.classList.remove('hvmepp-hidden');
        bindPairedPanelFocus(overlay);
        focusPairedPanel(overlay);
        syncUI();
        calculate();
        return;
      }
      panelElements = buildPanel();
      document.body.appendChild(panelElements.overlay);
      bindPairedPanelFocus(panelElements.overlay);
      focusPairedPanel(panelElements.overlay);
      bindPanelEvents(panelElements);
      syncUI();
      calculate();
    }

    const QUALITY_EN_TO_CN = {
      Superior: '上等', Exquisite: '优良', Magnificent: '史诗', Legendary: '传奇', Peerless: '无双', Ultimate: '至尊'
    };
    const RARE_EQUIPMENT_MATERIALS = [
      { rareMaterial: '相位碎片', baseMaterial: '布料', terms: ['phase armor', 'phase'] },
      { rareMaterial: '暗影碎片', baseMaterial: '皮革', terms: ['shade armor', 'shade'] },
      { rareMaterial: '动力碎片', baseMaterial: '金属', terms: ['power armor', 'power'] },
      { rareMaterial: '力场碎片', baseMaterial: '金属', terms: ['force shield', 'force-shield'] }
    ];
    const RARE_ARMOR_TYPE_RULES = [
      { display: '相位', terms: ['phase armor', 'phase'] },
      { display: '暗影', terms: ['shade armor', 'shade'] },
      { display: '动力', terms: ['power armor', 'power'] },
      { display: '反应装甲', terms: ['reactive armor', 'reactive'] }
    ];
    const SINGLE_HANDED_WEAPON_TERMS = [
      'axe', 'club', 'rapier', 'shortsword', 'wakizashi', 'dagger'
    ];
    const TWO_HANDED_WEAPON_TERMS = [
      'estoc', 'longsword', 'katana', 'scythe', 'great mace', 'swordchucks'
    ];
    const SHIELD_TERMS = ['buckler', 'kite shield', 'tower shield', 'force shield'];
    const STAFF_TERMS = ['staff', 'oak', 'redwood', 'willow', 'katalox', 'ebony'];
    function getSlotEnglishText(slot) {
      return `${slot.weaponType || ''} ${slot.enName || slot.name || ''}`.toLowerCase();
    }
    function isArmorSlot(slot) {
      const type = getSlotEnglishText(slot);
      const isShield = type.includes('buckler') || type.includes('kite shield') || type.includes('tower shield') || type.includes('force shield');
      return slot.slotId !== 1 && (slot.slotId !== 2 || isShield) && (
        type.includes('armor') || type.includes('shield') ||
        [11, 12, 13, 14, 15].includes(slot.slotId)
      );
    }
    function detectRareEquipmentMaterial(slot) {
      if (!isArmorSlot(slot)) return null;
      const text = getSlotEnglishText(slot);
      const match = RARE_EQUIPMENT_MATERIALS.find(item => item.terms.some(term => text.includes(term)));
      return match ? match.rareMaterial : null;
    }
    function detectRareArmorType(slot) {
      if (!isArmorSlot(slot)) return null;
      const text = getSlotEnglishText(slot);
      return RARE_ARMOR_TYPE_RULES.find(rule => includesEquipmentTerm(text, rule.terms)) || null;
    }
    function includesEquipmentTerm(text, terms) {
      return terms.some(term => text.includes(term.toLowerCase()));
    }
    function detectEquipmentType(slot) {
      const text = getSlotEnglishText(slot);
      if (includesEquipmentTerm(text, SHIELD_TERMS)) return '盾牌';
      if (includesEquipmentTerm(text, STAFF_TERMS)) return '法杖';
      if (includesEquipmentTerm(text, SINGLE_HANDED_WEAPON_TERMS) || text.includes('one-handed')) return '单手武器';
      if (includesEquipmentTerm(text, TWO_HANDED_WEAPON_TERMS) || text.includes('two-handed')) return '双手武器';
      const rareArmor = detectRareArmorType(slot);
      if (rareArmor) return rareArmor.display;
      if (text.includes('cloth armor')) return '布甲';
      if (text.includes('light armor')) return '轻甲';
      if (text.includes('heavy armor')) return '重甲';
      if (text.includes('cloth')) return '布甲';
      if (text.includes('light')) return '轻甲';
      if (text.includes('heavy')) return '重甲';
      return '未知类型';
    }
    function normalizePlanQuality(slot) {
      const quality = QUALITY_EN_TO_CN[slot.quality] || slot.quality;
      return QUALITY_CONFIG[quality] ? quality : '上等';
    }
    function detectMaterialType(slot) {
      const type = getSlotEnglishText(slot);
      const rareMaterial = detectRareEquipmentMaterial(slot);
      const rareConfig = RARE_EQUIPMENT_MATERIALS.find(item => item.rareMaterial === rareMaterial);
      if (rareConfig) return rareConfig.baseMaterial;
      if (detectRareArmorType(slot)?.display === '反应装甲') return '金属';
      if (includesEquipmentTerm(type, ['force shield'])) return '金属';
      if (includesEquipmentTerm(type, SHIELD_TERMS)) return '木材';
      if (type.includes('staff') || type.includes('wood')) return '木材';
      if (type.includes('cloth') || type.includes('cotton') || type.includes('silk')) return '布料';
      if (type.includes('light armor') || type.includes('leather')) return '皮革';
      if (type.includes('heavy armor') || type.includes('plate') || type.includes('metal')) return '金属';
      if (/one-handed|two-handed|dual-wielding/.test(type) || slot.slotId === 1 || slot.slotId === 2) return '金属';
      return '皮革';
    }
    function detectCoreType(slot, materialType) {
      const type = getSlotEnglishText(slot);
      if (includesEquipmentTerm(type, SHIELD_TERMS)) return '护甲';
      if (materialType === '木材' || type.includes('staff')) return '法杖';
      if (slot.slotId === 1 || slot.slotId === 2 || /one-handed|two-handed|dual-wielding/.test(type)) return '武器';
      return '护甲';
    }
    function calculatePlan(equipSlots, levelMap) {
      const details = [];
      const totalsByKey = { Credits: 0 };
      let invalidCount = 0;
      for (const slot of equipSlots) {
        if (!slot.available || !slot.name) continue;
        const levels = levelMap[slot.index] || { forge: slot.forge, iw: slot.iw };
        const fromLvl = slot.forge;
        const toLvlValue = Number(levels.forge);
        const toLvl = Number.isFinite(toLvlValue) ? toLvlValue : slot.forge;
        const fromIW = slot.iw;
        const toIWValue = Number(levels.iw);
        const toIW = Number.isFinite(toIWValue) ? toIWValue : slot.iw;
        if (toLvl <= fromLvl && toIW <= fromIW) {
          continue;
        }
        const materialType = detectMaterialType(slot);
        const coreType = detectCoreType(slot, materialType);
        const rareMaterial = detectRareEquipmentMaterial(slot);
        const rareArmorType = detectRareArmorType(slot);
        const result = calculateUpgradeFor({
          materialType,
          quality: normalizePlanQuality(slot),
          currentLevel: fromLvl,
          targetLevel: toLvl,
          currentIW: fromIW,
          targetIW: toIW,
          useRare: Boolean(rareMaterial),
          rareMaterial: rareMaterial || plannerState.rareMaterial,
          coreType,
          useCoreDeduction: plannerState.useCoreDeduction,
          useInventory: false
        });
        if (!result.ok) {
          invalidCount++;
          continue;
        }
        Object.entries(result.materialTotals).forEach(([key, quantity]) => {
          if (quantity > 0) totalsByKey[key] = (totalsByKey[key] || 0) + quantity;
        });
        totalsByKey.Credits += result.creditsCost;
        details.push({
          slot,
          equipmentType: detectEquipmentType(slot),
          fromLvl,
          toLvl,
          fromIW,
          toIW,
          materialType,
          coreType,
          isRare: Boolean(rareMaterial || rareArmorType),
          rareMaterial,
          result,
          rawCost: result.rawMaterialCost + result.rawCoreCost + result.creditsCost
        });
      }
      const prices = readHvUtilsPrices();
      const resourceRows = [];
      let materialCost = 0;
      let coreCashCost = 0;
      let creditsCost = totalsByKey.Credits || 0;
      Object.entries(totalsByKey).forEach(([key, total]) => {
        if (key === 'Credits' || total <= 0) return;
        const isLegendary = key.startsWith('Legendary ');
        const isPeerless = key.startsWith('Peerless ');
        const isCore = isLegendary || isPeerless;
        const fixedPrice = isLegendary ? CORE_FIXED_PRICE.Legendary : isPeerless ? CORE_FIXED_PRICE.Peerless : 0;
        const price = isCore ? (plannerState.useCoreDeduction ? positiveNumber(prices[key]) || fixedPrice : fixedPrice) : positiveNumber(prices[key]);
        const held = plannerState.useInventory ? Math.max(0, Number(plannerState.inventory[key]) || 0) : 0;
        const needBuy = Math.max(0, total - held);
        const subtotal = needBuy * price;
        if (isCore) coreCashCost += subtotal; else materialCost += subtotal;
        resourceRows.push({ key, total, held, needBuy, price, subtotal, isCore });
      });
      return {
        details,
        totalsByKey,
        resourceRows,
        materialCost,
        coreCashCost,
        creditsCost,
        totalCost: materialCost + coreCashCost + creditsCost,
        useInventory: plannerState.useInventory,
        rareCount: details.filter(detail => detail.isRare).length,
        useCoreDeduction: plannerState.useCoreDeduction,
        invalidCount
      };
    }
    function renderPlan(equipSlots, levelMap) {
      const old = document.getElementById('hvmepp-plan-overlay');
      let savedPosition = null;
      let savedZIndex = null;
      if (old) {
        const rect = old.getBoundingClientRect();
        savedPosition = {
          left: old.style.left || `${rect.left}px`,
          top: old.style.top || `${rect.top}px`,
          scrollTop: old.querySelector('.hvmepp-scroll')?.scrollTop ?? old.scrollTop
        };
        savedZIndex = old.style.zIndex || (typeof getComputedStyle === 'function' ? getComputedStyle(old).zIndex : null);
        old.remove();
      }
      const plan = calculatePlan(equipSlots, levelMap);
      if (!plan.details.length) {
        const message = plan.invalidCount > 0
          ? '预览等级已变化，但目标等级超过了装备品质可强化上限，请检查品质或等级设置。'
          : '当前没有高于装备当前锻造等级或 IW 等级的预览强化方案。请先提高锻造等级或 IW 等级。';
        showToast(message);
        return;
      }
      const overlay = elt('div', { id: 'hvmepp-plan-overlay' });
      if (savedPosition) {
        overlay.style.left = savedPosition.left;
        overlay.style.top = savedPosition.top;
        overlay.style.right = 'auto';
      }
      const panel = elt('div', { class: 'hvmepp-plan-panel' });
      const close = elt('button', { type: 'button', class: 'hvmepp-close', text: '×', title: '关闭', 'aria-label': '关闭' });
      const title = elt('div', { class: 'hvmepp-title' }, [elt('span', { text: '计算材料：预览强化方案' }), close]);
      makeDraggable(overlay, title);
      close.addEventListener('click', () => overlay.remove());
      panel.appendChild(title);

      const planControls = elt('div', { class: 'hvmepp-controls hvmepp-plan-controls' });
      const coreDeduction = elt('input', { type: 'checkbox' });
      coreDeduction.checked = plannerState.useCoreDeduction;
      const inventory = elt('input', { type: 'checkbox' });
      inventory.checked = plannerState.useInventory;
      const priceSource = elt('select');
      PRICE_SOURCE_OPTIONS.forEach(([value, text]) => {
        priceSource.appendChild(elt('option', { value, text, selected: value === plannerState.priceSource }));
      });
      const refreshPrice = elt('button', { text: '刷新市场价格' });
      const refreshInventoryButton = elt('button', { text: '刷新库存数量' });
      planControls.append(
        elt('label', {}, [coreDeduction, ' 购买核心抵扣']),
        elt('label', {}, [inventory, ' 使用库存强化']),
        elt('label', {}, ['价格来源 ', priceSource]),
        refreshPrice,
        refreshInventoryButton
      );
      coreDeduction.addEventListener('change', () => {
        plannerState.useCoreDeduction = coreDeduction.checked;
        saveState();
        renderPlan(equipSlots, levelMap);
      });
      inventory.addEventListener('change', () => {
        plannerState.useInventory = inventory.checked;
        saveState();
        renderPlan(equipSlots, levelMap);
      });
      priceSource.addEventListener('change', () => {
        plannerState.priceSource = priceSource.value;
        saveState();
        renderPlan(equipSlots, levelMap);
      });
      refreshPrice.addEventListener('click', async () => {
        await refreshPrices(plannerState.priceSource, refreshPrice);
        renderPlan(equipSlots, levelMap);
      });
      refreshInventoryButton.addEventListener('click', () => {
        refreshInventory(refreshInventoryButton, () => renderPlan(equipSlots, levelMap));
      });
      panel.appendChild(planControls);
      panel.appendChild(elt('div', { class: 'hvmepp-plan-note', text: `共 ${plan.details.length} 件装备；自动识别稀有材质装备 ${plan.rareCount} 件；${plan.useInventory ? '已扣除库存' : '未扣除库存'}。` }));

      const planInventoryDisplay = elt('div', {
        class: 'hvmepp-plan-inventory-display',
        style: 'font-size:9pt;color:#555;margin:4px 0;padding:4px 8px;background:#f8f6ee;border:1px solid #ddd;white-space:pre-wrap;'
      });
      updateInventoryDisplayNode(planInventoryDisplay);
      panel.appendChild(planInventoryDisplay);
      panel.appendChild(elt('div', { class: 'hvmepp-total' }, [
        '预览方案总成本：', elt('span', { class: 'hvmepp-good', text: formatMoney(plan.totalCost) }),
        `（材料 ${formatMoney(plan.materialCost)} + 核心 ${formatMoney(plan.coreCashCost)} + 基础c ${formatMoney(plan.creditsCost)}）`
      ]));

      const detailTable = elt('table', { class: 'hvmepp-table hvmepp-plan-detail-table' });
      detailTable.appendChild(elt('tr', {}, ['装备类型', '材料/核心', '品质', '锻造等级', '是否为稀有材质', '基础c', '原始估算'].map(text => elt('th', { text }))));
      plan.details.forEach(detail => {
        appendResultRow(detailTable, [
          detail.equipmentType,
          `${detail.materialType}/${detail.coreType}`,
          detail.result.quality,
          `${detail.fromLvl} → ${detail.toLvl}${detail.fromIW !== detail.toIW ? ` / IW${detail.fromIW} → ${detail.toIW}` : ''}`,
          detail.isRare ? '是' : '否',
          formatMoney(detail.result.creditsCost),
          formatMoney(detail.rawCost)
        ]);
      });
      panel.appendChild(detailTable);

      const resourceTable = elt('table', { class: 'hvmepp-table' });
      resourceTable.appendChild(elt('tr', {}, ['材料/核心', '总需求', '库存', '需购买', '单价', '小计'].map(text => elt('th', { text }))));
      plan.resourceRows.forEach(row => appendResultRow(resourceTable, [
        getDisplayName(row.key),
        formatNumber(row.total),
        plan.useInventory ? formatNumber(row.held) : '不使用',
        formatNumber(row.needBuy),
        formatPrice(row.price),
        formatMoney(row.subtotal)
      ]));
      appendResultRow(resourceTable, ['基础 c', formatNumber(plan.creditsCost), '-', formatNumber(plan.creditsCost), '-', formatMoney(plan.creditsCost)]);
      panel.appendChild(resourceTable);

      const levelDetailButton = elt('button', { text: '显示/隐藏逐级明细' });
      const levelDetailContainer = elt('div', { style: 'display:none; max-height:300px; overflow:auto; margin-top:6px;' });
      let levelDetailBuilt = false;
      const formatNeed = (key, quantity) => quantity > 0 ? `${getDisplayName(key)}×${formatNumber(quantity)}` : '—';
      levelDetailButton.addEventListener('click', () => {
        if (!levelDetailBuilt) {
          const levelTable = elt('table', { class: 'hvmepp-table' });
          levelTable.appendChild(elt('tr', {}, ['装备类型', '等级', '低级材料', '中级材料', '高级材料', '稀有材料', '世界之种', '传奇核心', '无双核心', '基础c'].map(text => elt('th', { text }))));
          plan.details.forEach(detail => {
            detail.result.breakdown.forEach(level => {
              levelTable.appendChild(elt('tr', {}, [
                elt('td', { text: detail.equipmentType }),
                elt('td', { text: level.level }),
                elt('td', { text: formatNeed(detail.result.lowKey, level.low) }),
                elt('td', { text: formatNeed(detail.result.midKey, level.mid) }),
                elt('td', { text: formatNeed(detail.result.highKey, level.high) }),
                elt('td', { text: level.rare > 0 && detail.result.rareDisplayName ? `${detail.result.rareDisplayName}×${formatNumber(level.rare)}` : '—' }),
                elt('td', { text: '—' }),
                elt('td', { text: formatNumber(level.legendaryCore) }),
                elt('td', { text: formatNumber(level.peerlessCore) }),
                elt('td', { text: formatMoney(level.credits) })
              ]));
            });
            detail.result.iwBreakdown.forEach(level => {
              levelTable.appendChild(elt('tr', {}, [
                elt('td', { text: detail.equipmentType }),
                elt('td', { text: `IW${level.level}` }),
                elt('td', { text: '—' }),
                elt('td', { text: '—' }),
                elt('td', { text: '—' }),
                elt('td', { text: '—' }),
                elt('td', { text: formatNeed(detail.result.worldSeedKey, level.worldSeed) }),
                elt('td', { text: '—' }),
                elt('td', { text: '—' }),
                elt('td', { text: '—' })
              ]));
            });
          });
          levelDetailContainer.appendChild(levelTable);
          levelDetailBuilt = true;
        }
        levelDetailContainer.style.display = levelDetailContainer.style.display === 'none' ? 'block' : 'none';
      });
      panel.append(levelDetailButton, levelDetailContainer);

      overlay.appendChild(panel);
      splitPanelScrollable(panel);
      document.body.appendChild(overlay);
      bindPairedPanelFocus(overlay);
      if (savedZIndex) {
        overlay.style.zIndex = savedZIndex;
      } else {
        focusPairedPanel(overlay);
      }
      if (savedPosition) {
        const scrollBody = overlay.querySelector('.hvmepp-scroll');
        if (scrollBody) scrollBody.scrollTop = savedPosition.scrollTop;
      }
    }
    function setupKeyboardShortcut() {
      document.addEventListener('keydown', event => {
        const tag = event.target?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || event.target?.isContentEditable) return;
        if (event.key !== 'x' && event.key !== 'X') return;
        event.preventDefault();
        const overlay = $(`#${CONFIG.IDS.overlay}`);
        if (!overlay) { renderPanel(); return; }
        overlay.classList.toggle('hvmepp-hidden');
        if (!overlay.classList.contains('hvmepp-hidden')) {
          bindPairedPanelFocus(overlay);
          focusPairedPanel(overlay);
          syncUI();
          calculate();
        }
      });
    }
    function addStyle() {
      const css = `
                #hvmepp-overlay { position:absolute; top:120px; left:700px; width:520px; max-height:85vh; overflow:hidden; display:flex; flex-direction:column; background:#f5f0e8; border:2px solid #5c0d11; border-radius:8px; padding:0; z-index:9999; font:10pt Verdana,sans-serif; color:#222; box-shadow:0 4px 8px rgba(0,0,0,.3); user-select:text; cursor:default; box-sizing:border-box; }
                #hvmepp-plan-overlay { position:absolute; top:120px; left:700px; width:min(900px,calc(100vw - 28px)); max-height:85vh; overflow:hidden; display:flex; flex-direction:column; background:#f5f0e8; border:2px solid #5c0d11; border-radius:8px; padding:0; z-index:9998; font:10pt Verdana,sans-serif; color:#222; box-shadow:0 4px 8px rgba(0,0,0,.3); user-select:text; cursor:default; box-sizing:border-box; }
                #hvmepp-overlay.hvmepp-hidden { display:none; }
                #hvmepp-panel, .hvmepp-plan-panel { width:auto; max-height:none; overflow:hidden; background:transparent; border:0; padding:0; box-shadow:none; font:inherit; text-align:left; flex:1 1 auto; min-height:0; display:flex; flex-direction:column; }
                .hvmepp-scroll { flex:1 1 auto; min-height:0; overflow-y:auto; padding:0 10px 10px; }
                .hvmepp-title { position:relative; flex:0 0 auto; z-index:3; display:flex; justify-content:space-between; align-items:center; padding:6px 10px; margin:0; border-bottom:2px solid #a47c78; background:#d4cfc0; border-radius:8px 8px 0 0; cursor:move; user-select:none; font-weight:bold; font-size:11pt; color:#5c0d11; }
                .hvmepp-close { width:24px; height:24px; padding:0; border:0; background:transparent; color:#5c0d11; font-size:20px; line-height:20px; cursor:pointer; }
                .hvmepp-status, .hvmepp-total { margin:6px 0; padding:6px 8px; background:#fff8; border:1px solid #b9aa99; }
                .hvmepp-plan-note { margin:6px 0; color:#555; line-height:1.4; }
                .hvmepp-total { line-height:1.7; font-weight:bold; }
                .hvmepp-controls { display:flex; flex-wrap:wrap; gap:6px 10px; align-items:center; margin:8px 0; }
                .hvmepp-controls input, .hvmepp-controls select { font-size:10pt; }
                .hvmepp-controls button, .hvmepp-plan-panel button { cursor:pointer; }
                .hvmepp-table { width:100%; border-collapse:collapse; margin:6px 0; table-layout:fixed; }
                .hvmepp-table th, .hvmepp-table td { border:1px solid #b9aa99; padding:3px 4px; text-align:center; overflow-wrap:anywhere; }
                .hvmepp-table th { background:#edb; }
                .hvmepp-good { color:#006400; font-weight:bold; }
                .hvmepp-alert { margin:8px 0; padding:8px; border:1px solid #b00020; color:#b00020; background:#fff2f2; font-weight:bold; }
                @media (max-width:900px) { #hvmepp-overlay, #hvmepp-plan-overlay { top:70px; left:7px; width:calc(100vw - 14px); max-height:calc(100vh - 14px); } }
            `;
      if (typeof GM_addStyle === 'function') GM_addStyle(css);
      else {
        const style = document.createElement('style');
        style.textContent = css;
        document.head.appendChild(style);
      }
    }
    addStyle();
    setupKeyboardShortcut();
    function updatePlan(equipSlots, levelMap) {
      if (document.getElementById('hvmepp-plan-overlay')) renderPlan(equipSlots, levelMap);
    }
    return { open: renderPanel, openPlan: renderPlan, updatePlan, refreshPrices, refreshInventory, getInventory: () => ({ ...plannerState.inventory }) };
  })();


  function isEquipmentPage() {
    try {
      const url = new URL(location.href);
      const isEquipmentPath = url.pathname === '/' || url.pathname === '/isekai/' || url.pathname === '/isekai';
      return isEquipmentPath &&
        url.searchParams.get('s') === 'Character' &&
        url.searchParams.get('ss') === 'eq' &&
        !url.searchParams.has('equip_slot');
    } catch (e) {
      return false;
    }
  }

  function removeMaccCheckPanel() {
    document.getElementById('hv-macc-panel')?.remove();
    if (maccCheckObserver) {
      maccCheckObserver.disconnect();
      maccCheckObserver = null;
    }
    if (maccCheckMageResizeObserver) {
      maccCheckMageResizeObserver.disconnect();
      maccCheckMageResizeObserver = null;
      maccCheckMageResizeTarget = null;
    }
  }

  function removeUpgradeButton() {
    document.getElementById('hv-upgrade-btn')?.remove();
    document.getElementById('hv-easter-egg')?.remove();
    removeMaccCheckPanel();
  }

  function addUpgradeButton() {
    if (!isEquipmentPage()) {
      removeUpgradeButton();
      return;
    }
    let container = document.querySelector('.hvut-eq-buttons');
    if (!container) {
      container = document.createElement('div');
      container.className = 'hvut-eq-buttons';
      container.style.cssText = 'display:flex; gap:5px; margin:5px 0;';
      const leftDiv = document.querySelector('#eqch_left');
      if (leftDiv) {
        leftDiv.prepend(container);
      } else {
        document.body.prepend(container);
      }
    }

    let btn = document.getElementById('hv-upgrade-btn');
    if (!btn) {
      btn = document.createElement('input');
      btn.id = 'hv-upgrade-btn';
      btn.type = 'button';
      btn.value = '装备升级';
    } else {
      btn.removeAttribute('style');
    }
    btn.onclick = async function() {
      const equipData = getEquipmentData();
      if (equipData.length === 0) {
        alert('未能读取到装备数据，请确保页面已完全加载。');
        return;
      }

      btn.disabled = true;
      try {
        const charmDataPromise = waitForEquipmentCharmData(equipData, true);
        const charmDataTimeout = new Promise(resolve => {
          window.setTimeout(() => resolve(equipData), 1500);
        });
        const preparedEquipData = await Promise.race([charmDataPromise, charmDataTimeout]);
        buildUpgradePanel(preparedEquipData);
      } finally {
        btn.disabled = false;
      }
    };
    const oldParent = btn.parentElement;
    const buttons = container.querySelectorAll('input[type="button"]');
    const anchor = buttons[1];
    if (anchor && anchor !== btn) {
      const next = anchor.nextSibling;
      if (next) container.insertBefore(btn, next);
      else container.appendChild(btn);
    } else if (!anchor) {
      container.appendChild(btn);
    }
    if (oldParent && oldParent !== container && oldParent.classList.contains('hvut-eq-buttons') && !oldParent.querySelector('input')) {
      oldParent.remove();
    }
  }


  charmSimulation = (() => {
    let popup = null;
    let effectDisplay = null;
    let activeSlotKey = 'main';

    function createEmptyCharmMap(value) {
      const map = {};
      CHARM_SLOT_KEYS.forEach(key => { map[key] = value === undefined ? [] : value; });
      return map;
    }

    const charmState = {
      actualCharms: createEmptyCharmMap(),
      selected: createEmptyCharmMap(),
      userEdited: createEmptyCharmMap(false),
      loading: false,
    };

    const slotStatusEls = {};
    const modifiedSlots = {};

    const WEAPON_CLASS_LABELS = { staff: '法杖', onehand: '单手', twohand: '双手', shield: '盾牌' };

    function getCharmSlots() {
      const slots = activeUpgradeSimulation?.equipSlots || getEquipmentData();
      const result = {};
      (slots || []).forEach((slot, index) => {
        const key = getCharmSlotKey(slot, index);
        if (!key || !slot?.available) return;
        if (!result[key]) result[key] = slot;
      });
      return result;
    }

    function isDefenseCharmSlot(key, slot) {
      if (key === 'main') return false;
      if (key === 'off') return resolveWeaponClass(slot) === 'shield';
      return true;
    }

    function filterCharmsForSlot(key, charms, slot) {
      const defenseSlot = isDefenseCharmSlot(key, slot);
      return (charms || []).filter(charm => {
        const def = charm && CHARM_DEFS[charm.type];
        if (!def) return false;
        return defenseSlot ? def.category === 'defense' : def.category === 'attack';
      });
    }

    function getLivePanelDetails(sectionKey, title) {
      const enRow = findEnglishPanelRow(sectionKey, title);
      if (!enRow) return null;
      const liveItem = findLiveRowByEnglishRow(sectionKey, enRow);
      const details = liveItem ? readLiveRowIncrement(liveItem) : null;
      let charmIncrement = 0;
      if (liveItem) {
        const entry = PANEL_INCREMENT_SOURCES.get(liveItem.tr || liveItem.td2);
        if (entry) charmIncrement = Number(entry.charm || 0);
      }
      const increment = details ? details.increment - charmIncrement : 0;
      return {
        base: enRow.value,
        increment,
        value: enRow.value + increment,
      };
    }

    function normalizeCharms(list) {
      return (list || []).map(charm => charm.type + ':' + charm.size).sort().join(',');
    }

    function slotHasChanges(key) {
      return normalizeCharms(charmState.selected[key]) !== normalizeCharms(charmState.actualCharms[key]);
    }

    function collectSelectionsFromDom(key) {
      if (!popup) return [];
      const charms = [];
      popup.querySelectorAll('[data-slot="' + key + '"]').forEach(row => {
        const type = row.dataset.type;
        const sizeBtn = row.querySelector('[data-role="size"]');
        const size = sizeBtn && sizeBtn.dataset.size;
        if (type && CHARM_DEFS[type] && (size === 'lesser' || size === 'greater')) {
          charms.push({ type, size });
        }
      });
      return charms;
    }
    function getSelectedCharmsForSlot(key) {
      return Array.isArray(charmState.selected[key]) ? charmState.selected[key] : [];
    }

    function setActualCharmSelections(key, charms, slot) {
      const normalized = filterCharmsForSlot(key, charms, slot);
      charmState.selected[key] = normalized;
      if (!popup) return;
      const sizeByType = new Map(normalized.map(charm => [charm.type, charm.size]));
      popup.querySelectorAll('[data-slot="' + key + '"]').forEach(row => {
        const type = row.dataset.type;
        const size = sizeByType.get(type);
        const actualSizeEl = row.querySelector('[data-role="actual-size"]');
        const sizeBtn = row.querySelector('[data-role="size"]');
        if (!actualSizeEl || !sizeBtn) return;
        const label = size ? (size === 'greater' ? '大' : '小') : '无';
        actualSizeEl.textContent = label;
        applyCharmSizeColor(actualSizeEl, size || 'none');
        sizeBtn.dataset.size = size || 'none';
        sizeBtn.textContent = label;
        applyCharmSizeColor(sizeBtn, size || 'none');
      });
    }
    const CHARM_SIZE_COLORS = { lesser: '#1a66cc', greater: '#1e8a3c' };
    function applyCharmSizeColor(el, size) {
      el.style.color = (size === 'lesser' || size === 'greater') ? CHARM_SIZE_COLORS[size] : '';
    }
    function restoreActualCharmSelections() {
      const slots = getCharmSlots();
      CHARM_SLOT_KEYS.forEach(key => {
        const slot = slots[key];
        const info = slot?.eid && CHARM_INFO_CACHE.has(slot.eid)
          ? CHARM_INFO_CACHE.get(slot.eid)
          : null;
        charmState.actualCharms[key] = filterCharmsForSlot(key, info, slot);
        if (slot) slot.actualCharms = Array.isArray(info) ? info : [];
        charmState.userEdited[key] = false;
        setActualCharmSelections(key, charmState.actualCharms[key], slot);
      });
    }

    function getCharmSlotEquipmentStatPair(slot, title, charms) {
      return {
        base: getPureEquipmentStatValue(slot, title, null, charms),
        sim: getPureEquipmentStatValue(slot, title, activeUpgradeSimulation?.state, charms),
      };
    }
    function getCharmNetEffects() {
      const level = getPlayerLevel();
      const slots = getCharmSlots();
      const net = {
        critDamage: 0,
        maccPercent: 0,
        maccFlat: 0,
        weaponMagicDamagePanel: 0,
        manaCostPanel: 0,
        castSpeedPanel: 0,
        counterResistPanel: 0,
        maccPanel: 0,
        maxHealthPercent: 0,
        maxManaPercent: 0,
        selectedMaxHealthPercent: 0,
        selectedMaxManaPercent: 0,
        actualMaxHealthPercent: 0,
        actualMaxManaPercent: 0,
      };
      CHARM_SLOT_KEYS.forEach(key => {
        const slot = slots[key];
        if (!slot) return;
        const defenseSlot = isDefenseCharmSlot(key, slot);
        const multiplier = defenseSlot ? getCharmSlotMultiplier(key) : 1;
        const weaponClass = resolveWeaponClass(slot);
        const selectedCharms = getSelectedCharmsForSlot(key);
        const actualCharms = Array.isArray(charmState.actualCharms[key]) ? charmState.actualCharms[key] : [];
        let statPairs = null;
        Object.keys(CHARM_DEFS).forEach(type => {
          const def = CHARM_DEFS[type];
          if (defenseSlot ? def.category !== 'defense' : def.category !== 'attack') return;
          const selectedInfo = selectedCharms.find(charm => charm.type === type);
          const actualInfo = actualCharms.find(charm => charm.type === type);
          const selectedEffect = selectedInfo
            ? getCharmEffect(selectedInfo.type, selectedInfo.size, weaponClass, level)
            : createZeroCharmEffect();
          const actualEffect = actualInfo
            ? getCharmEffect(actualInfo.type, actualInfo.size, weaponClass, level)
            : createZeroCharmEffect();
          if (defenseSlot) {
            net.maxHealthPercent += ((selectedEffect.maxHealthPercent || 0) - (actualEffect.maxHealthPercent || 0)) * multiplier;
            net.maxManaPercent += ((selectedEffect.maxManaPercent || 0) - (actualEffect.maxManaPercent || 0)) * multiplier;
            net.selectedMaxHealthPercent += (selectedEffect.maxHealthPercent || 0) * multiplier;
            net.selectedMaxManaPercent += (selectedEffect.maxManaPercent || 0) * multiplier;
            net.actualMaxHealthPercent += (actualEffect.maxHealthPercent || 0) * multiplier;
            net.actualMaxManaPercent += (actualEffect.maxManaPercent || 0) * multiplier;
            return;
          }
          if (!statPairs) {
            statPairs = {
              cast: getCharmSlotEquipmentStatPair(slot, 'Casting Speed', actualCharms),
              macc: getCharmSlotEquipmentStatPair(slot, 'Magic Accuracy', actualCharms),
              magicDamage: getCharmSlotEquipmentStatPair(slot, 'Magic Damage', actualCharms),
            };
          }
          const critDamageDelta = Number(selectedEffect.critDamage || 0) - Number(actualEffect.critDamage || 0);
          const counterResistDelta = Number(selectedEffect.counterResist || 0) - Number(actualEffect.counterResist || 0);
          const maccPercentDelta = Number(selectedEffect.maccPercent || 0) - Number(actualEffect.maccPercent || 0);
          const maccFlatDelta = Number(selectedEffect.maccFlat || 0) - Number(actualEffect.maccFlat || 0);
          net.critDamage += critDamageDelta;
          net.maccPercent += maccPercentDelta;
          net.maccFlat += maccFlatDelta;
          net.manaCostPanel += -(Number(selectedEffect.manaCostReduction || 0) - Number(actualEffect.manaCostReduction || 0));
          net.castSpeedPanel += Number(selectedEffect.castSpeed || 0) - Number(actualEffect.castSpeed || 0);
          net.counterResistPanel += counterResistDelta;
          net.maccPanel += (Number(selectedEffect.maccPercent || 0) / 100) * statPairs.macc.sim + (Number(selectedEffect.maccFlat || 0))
            - ((Number(actualEffect.maccPercent || 0) / 100) * statPairs.macc.sim + (Number(actualEffect.maccFlat || 0)));
          if (type === 'archmage') {
            if (selectedEffect.percent || actualEffect.percent) {
              net.weaponMagicDamagePanel += (Number(selectedEffect.weaponMagicDamage || 0) / 100) * statPairs.magicDamage.sim
                - (Number(actualEffect.weaponMagicDamage || 0) / 100) * statPairs.magicDamage.sim;
            } else {
              net.weaponMagicDamagePanel += Number(selectedEffect.weaponMagicDamage || 0) - Number(actualEffect.weaponMagicDamage || 0);
            }
          }
        });
      });
      return net;
    }

    function formatCharmDelta(value) {
      if (Math.abs(value) < 0.0001) return '';
      const sign = value > 0 ? '+' : '';
      const rounded = Math.round(value * 100) / 100;
      const text = Math.abs(rounded % 1) < 0.005 ? String(Math.round(rounded)) : rounded.toFixed(2);
      return sign + text;
    }

    function updateCharmEffectDisplay(net) {
      if (!effectDisplay || !effectDisplay.isConnected) return;
      const key = activeSlotKey;
      const charms = getSelectedCharmsForSlot(key);
      const label = charms.length
        ? charms.map(charm =>
          (CHARM_DEFS[charm.type]?.label || charm.type) +
          (charm.size === 'greater' ? ' 大' : ' 小')
        ).join('，')
        : '无';
      const selectedText = (CHARM_SLOT_LABELS[key] || key) + ': ' + label;
      const parts = [];
      if (Math.abs(net.weaponMagicDamagePanel) >= 0.0001) parts.push('武器魔法伤害 ' + formatCharmDelta(net.weaponMagicDamagePanel));
      if (Math.abs(net.manaCostPanel) >= 0.0001) parts.push('魔耗减免 ' + formatCharmDelta(net.manaCostPanel) + '%');
      if (Math.abs(net.castSpeedPanel) >= 0.0001) parts.push('施法速度 ' + formatCharmDelta(net.castSpeedPanel) + '%');
      if (Math.abs(net.critDamage) >= 0.0001) parts.push('魔法暴击伤害 ' + formatCharmDelta(net.critDamage));
      if (Math.abs(net.counterResistPanel) >= 0.0001) parts.push('反抵抗 ' + formatCharmDelta(net.counterResistPanel) + '%');
      if (Math.abs(net.maccPanel) >= 0.0001 || Math.abs(net.maccPercent) >= 0.0001 || Math.abs(net.maccFlat) >= 0.0001) {
        const percentText = formatCharmDelta(net.maccPercent);
        const flatText = formatCharmDelta(net.maccFlat);
        let expr = '';
        if (percentText && flatText) expr = percentText + '%' + flatText;
        else if (percentText) expr = percentText + '%';
        else if (flatText) expr = flatText;
        const maccText = '魔法命中 ' + formatCharmDelta(net.maccPanel) + (expr ? ' (' + expr + ')' : '');
        parts.push(maccText);
      }
      if (Math.abs(net.maxHealthPercent) >= 0.0001) parts.push('生命 ' + formatCharmDelta(net.maxHealthPercent) + '%');
      if (Math.abs(net.maxManaPercent) >= 0.0001) parts.push('魔力 ' + formatCharmDelta(net.maxManaPercent) + '%');
      const loadingText = charmState.loading ? '　护符读取中...' : '';
      effectDisplay.textContent = selectedText + '｜' + (parts.length ? parts.join('，') : '无变化') + loadingText;
    }

    function clearCharmPanelIncrements() {
      clearPanelIncrementSources('charm');
      renderPanelIncrements();
    }

    function getTankLevelMultiplier(kind) {
      const level = kind === 'health' ? tankSettings.hpTankLevel : tankSettings.mpTankLevel;
      return 1 + (level || 0) * 0.1;
    }

    function getCharmVitalDelta(vitals, tankMultiplier, actualPercent, selectedPercent) {
      const divider = tankMultiplier + (Number(actualPercent) || 0) / 100;
      const baseActual = (vitals.base || 0) / divider;
      const baseSim = (vitals.value || 0) / divider;
      return baseSim * (Number(selectedPercent) || 0) / 100 - baseActual * (Number(actualPercent) || 0) / 100;
    }

    function updateCharmPanelIncrements(net) {
      clearCharmPanelIncrements();
      if (!gEnglishStatsPanel || !getStatsPanelIndex()) return;
      const entries = [
        ['magic', 'Magic Damage', net.weaponMagicDamagePanel || 0],
        ['magic', 'Mana Cost', net.manaCostPanel || 0],
        ['magic', 'Cast Speed Bonus', net.castSpeedPanel || 0],
        ['magic', 'Crit Multiplier', net.critDamage || 0],
        ['magic', 'Counter-resist', net.counterResistPanel || 0],
        ['magic', 'Accuracy', net.maccPanel || 0],
      ];
      if ((net.selectedMaxHealthPercent || 0) || (net.actualMaxHealthPercent || 0)) {
        const vitals = getLivePanelDetails('vitals', 'Base Health');
        if (vitals) entries.push(['vitals', 'Base Health', getCharmVitalDelta(vitals, getTankLevelMultiplier('health'), net.actualMaxHealthPercent, net.selectedMaxHealthPercent)]);
      }
      if ((net.selectedMaxManaPercent || 0) || (net.actualMaxManaPercent || 0)) {
        const vitals = getLivePanelDetails('vitals', 'Base Mana');
        if (vitals) entries.push(['vitals', 'Base Mana', getCharmVitalDelta(vitals, getTankLevelMultiplier('mana'), net.actualMaxManaPercent, net.selectedMaxManaPercent)]);
      }
      const pending = new Map();
      entries.forEach(([sectionKey, title, diff]) => {
        if (Math.abs(diff) < 0.00005) return;
        const enRow = findEnglishPanelRow(sectionKey, title);
        if (!enRow) return;
        const liveItem = findLiveRowByEnglishRow(sectionKey, enRow);
        if (!liveItem?.td2) return;
        const key = liveItem.tr || liveItem.td2;
        const entry = pending.get(key) || { item: liveItem, diff: 0 };
        entry.diff += diff;
        pending.set(key, entry);
      });
      pending.forEach(({ item, diff }) => setPanelIncrementSource(item, 'charm', diff));
      renderPanelIncrements();
    }

    function updateWeaponClassDisplays() {
      if (!popup) return;
      const slots = getCharmSlots();
      ['main', 'off'].forEach(key => {
        const el = popup.querySelector('[data-weapon-class="' + key + '"]');
        if (!el) return;
        const cls = resolveWeaponClass(slots[key]);
        el.textContent = cls ? '(' + (WEAPON_CLASS_LABELS[cls] || cls) + ')' : '';
      });
    }

    function setSlotModified(key, changed) {
      modifiedSlots[key] = Boolean(changed);
      const el = slotStatusEls[key];
      if (el) el.style.background = changed ? '#d8cfc0' : '';
    }
    function updatePopupCharmRowStyles() {
      if (!popup || !popup.isConnected) return;
      const key = activeSlotKey || popup.dataset.hvCharmSlot;
      if (!key) return;
      const selectedByType = new Map((charmState.selected[key] || []).map(charm => [charm.type, charm.size]));
      const actualByType = new Map((charmState.actualCharms[key] || []).map(charm => [charm.type, charm.size]));
      popup.querySelectorAll('[data-slot="' + key + '"]').forEach(row => {
        const type = row.dataset.type;
        if (!type || !CHARM_DEFS[type]) return;
        const changed = (selectedByType.get(type) || null) !== (actualByType.get(type) || null);
        if (changed) {
          row.style.background = '#d8cfc0';
          row.style.borderRadius = '3px';
        } else {
          row.style.background = '';
          row.style.borderRadius = '';
        }
      });
    }
    function resetHandState() {
      charmState.actualCharms = createEmptyCharmMap();
      charmState.selected = createEmptyCharmMap();
      charmState.userEdited = createEmptyCharmMap(false);
      CHARM_SLOT_KEYS.forEach(key => {
        modifiedSlots[key] = false;
        const el = slotStatusEls[key];
        if (el) el.style.background = '';
      });
      clearCharmPanelIncrements();
      loadActualSlotCharms();
    }

    function registerHandStatusEl(key, el) {
      slotStatusEls[key] = el;
    }

    function recalc() {
      if (popup && popup.isConnected) refresh();
    }

    function loadActualSlotCharms(forceKey) {
      const slots = getCharmSlots();
      let pending = 0;
      CHARM_SLOT_KEYS.forEach(key => {
        const slot = slots[key];
        if (!slot?.eid) {
          charmState.actualCharms[key] = [];
          if (!charmState.userEdited[key]) charmState.selected[key] = [];
          return;
        }
        const force = forceKey === key;
        const cached = CHARM_INFO_CACHE.get(slot.eid);
        if (!force && cached !== undefined && isCharmInfoFresh(slot.eid)) {
          const info = cached;
          charmState.actualCharms[key] = filterCharmsForSlot(key, info, slot);
          slot.actualCharms = Array.isArray(info) ? info : [];
          if (!charmState.userEdited[key]) setActualCharmSelections(key, charmState.actualCharms[key], slot);
          if (activeUpgradeSimulation?.refreshEquipmentData) {
            activeUpgradeSimulation.refreshEquipmentData();
          }
          return;
        }
        pending++;
        charmState.loading = true;
        waitForEquipmentCharmInfo(slot.eid, force).then(info => {
          pending--;
          charmState.actualCharms[key] = filterCharmsForSlot(key, info, slot);
          slot.actualCharms = Array.isArray(info) ? info : [];
          if (!charmState.userEdited[key]) setActualCharmSelections(key, charmState.actualCharms[key], slot);
          if (activeUpgradeSimulation?.refreshEquipmentData) {
            activeUpgradeSimulation.refreshEquipmentData();
          }
          if (pending === 0) charmState.loading = false;
          if (popup?.isConnected) {
            updateWeaponClassDisplays();
            recalc();
          } else if (upgradePanel && upgradePanel.isConnected) {
            refresh();
          }
        }).catch(() => {
          pending--;
          if (pending === 0) charmState.loading = false;
          if (popup?.isConnected) {
            recalc();
          } else if (upgradePanel && upgradePanel.isConnected) {
            refresh();
          }
        });
      });
      if (pending === 0) {
        charmState.loading = false;
        updateWeaponClassDisplays();
      }
    }

    function createSection(key, titleText) {
      const section = document.createElement('div');
      section.dataset.slot = key;
      section.dataset.role = 'charm-section';
      section.style.cssText = 'margin: 8px 0 4px 0;';

      const header = document.createElement('div');
      header.style.cssText = 'display: flex; align-items: center; gap: 6px; font-weight: bold; margin-bottom: 3px;';
      const title = document.createElement('span');
      title.textContent = titleText;
      const weaponClass = document.createElement('span');
      weaponClass.dataset.weaponClass = key;
      weaponClass.style.cssText = 'color: #666; font-size: 9pt;';
      header.append(title, weaponClass);
      section.appendChild(header);

      const slots = getCharmSlots();
      const defenseSlot = isDefenseCharmSlot(key, slots[key]);
      const sizeLabels = { none: '无', lesser: '小', greater: '大' };
      Object.keys(CHARM_DEFS).forEach(type => {
        const def = CHARM_DEFS[type];
        if (defenseSlot ? def.category !== 'defense' : def.category !== 'attack') return;

        const row = document.createElement('div');
        row.dataset.slot = key;
        if (key === 'main' || key === 'off') row.dataset.hand = key;
        row.dataset.type = type;
        row.style.cssText = 'display: grid; grid-template-columns: minmax(0, 1fr) 34px 52px; gap: 4px; align-items: center; padding: 2px 0; border-bottom: 1px dotted #ddd;';

        const name = document.createElement('span');
        name.textContent = def.label;
        name.style.cssText = 'white-space: nowrap; overflow: hidden; text-overflow: ellipsis;';

        const actualSize = document.createElement('span');
        actualSize.dataset.role = 'actual-size';
        actualSize.textContent = '无';
        actualSize.style.cssText = 'text-align: center; color: #666; font-size: 9pt; white-space: nowrap;';

        const sizeBtn = document.createElement('span');
        sizeBtn.dataset.role = 'size';
        sizeBtn.dataset.size = 'none';
        sizeBtn.textContent = '无';
        sizeBtn.title = '点击切换状态';
        sizeBtn.style.cssText = [
          'font-weight: bold',
          'cursor: pointer',
          'padding: 0 4px',
          'color: #000',
          'min-width: 0',
          'width: 100%',
          'box-sizing: border-box',
          'text-align: center',
          'display: inline-block',
          'background: #e8e0d5',
          'border-radius: 3px',
          'user-select: none',
          'white-space: nowrap',
        ].join('; ');

        row.append(name, actualSize, sizeBtn);
        section.appendChild(row);

        const sizeCycle = ['none', 'lesser', 'greater'];
        sizeBtn.addEventListener('click', () => {
          charmState.userEdited[key] = true;
          const current = sizeCycle.indexOf(sizeBtn.dataset.size);
          const next = sizeCycle[(current + 1) % sizeCycle.length];
          sizeBtn.dataset.size = next;
          sizeBtn.textContent = sizeLabels[next];
          applyCharmSizeColor(sizeBtn, next);
          charmState.selected[key] = collectSelectionsFromDom(key);
          recalc();
        });
        sizeBtn.addEventListener('contextmenu', event => event.preventDefault());
      });

      return section;
    }
    async function open(key) {
      if (!CHARM_SLOT_LABELS[key]) return;
      if (!upgradePanel) return;
      if (popup && popup.isConnected && activeSlotKey === key) return;
      close();
      activeSlotKey = key;
      charmState.loading = false;

      const pop = document.createElement('div');
      pop.id = 'hv-charm-popup';
      pop.dataset.hvCharmSlot = key;
      pop.dataset.hvCharmHand = key;
      pop.style.cssText = [
        'position: absolute',
        'width: 310px',
        'max-height: 75vh',
        'overflow-x: hidden',
        'overflow-y: auto',
        'background: #f5f0e8',
        'border: 2px solid #5c0d11',
        'border-radius: 8px',
        'padding: 0 10px 10px 10px',
        'z-index: 10020',
        'font-family: Verdana, sans-serif',
        'font-size: 10pt',
        'box-shadow: 0 4px 8px rgba(0,0,0,0.35)',
        'user-select: text',
        'cursor: default'
      ].join('; ');

      const rect = upgradePanel.getBoundingClientRect();
      const viewportW = window.innerWidth || document.documentElement.clientWidth || 1200;
      pop.style.left = Math.max(4, Math.min(rect.right + 8, viewportW - 380)) + 'px';
      pop.style.top = Math.max(4, rect.top) + 'px';

      const header = document.createElement('div');
      header.style.cssText = [
        'display: flex',
        'justify-content: space-between',
        'align-items: center',
        'padding: 6px 10px',
        'margin: 0 -10px 8px -10px',
        'border-bottom: 2px solid #a47c78',
        'background: #d4cfc0',
        'border-radius: 8px 8px 0 0',
        'cursor: move',
        'user-select: none',
        'font-weight: bold',
        'font-size: 11pt',
        'color: #5c0d11'
      ].join('; ');

      const title = document.createElement('span');
      title.textContent = (CHARM_SLOT_LABELS[key] || key) + '护符调整';
      header.appendChild(title);

      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'hvmepp-close';
      closeBtn.textContent = '×';
      closeBtn.title = '关闭';
      closeBtn.setAttribute('aria-label', '关闭');
      closeBtn.onclick = close;
      header.appendChild(closeBtn);

      pop.appendChild(header);
      makeDraggable(pop, header);

      const body = document.createElement('div');
      body.style.cssText = 'max-height: calc(75vh - 48px); overflow-x: hidden; overflow-y: auto;';
      pop.appendChild(body);

      body.appendChild(createSection(key, CHARM_SLOT_LABELS[key] || key));

      effectDisplay = document.createElement('div');
      effectDisplay.dataset.role = 'effect';
      effectDisplay.style.cssText = 'margin: 6px 0 4px 0; font-size: 9pt; color: #444; line-height: 1.5; word-break: break-word;';
      body.appendChild(effectDisplay);

      const actionRow = document.createElement('div');
      actionRow.style.cssText = 'display: flex; align-items: center; margin-top: 4px;';
      const resetBtn = document.createElement('input');
      resetBtn.type = 'button';
      resetBtn.style.cssText = 'padding:3px 10px; font-size:11pt;';
      resetBtn.value = '重置为实际护符';
      resetBtn.onclick = () => {
        restoreActualCharmSelections();
        loadActualSlotCharms(key);
        recalc();
      };
      actionRow.appendChild(resetBtn);
      body.appendChild(actionRow);

      document.body.appendChild(pop);
      popup = pop;
      setActualCharmSelections(key, charmState.selected[key] || [], getCharmSlots()[key]);
      await ensureEnglishStatsPanel();
      if (!popup || !popup.isConnected) return;
      loadActualSlotCharms(key);
      recalc();
    }

    function close() {
      if (popup) {
        popup.remove();
        popup = null;
      }
      effectDisplay = null;
    }

    function refresh() {
      const charmNet = getCharmNetEffects();
      updateCharmPanelIncrements(charmNet);
      CHARM_SLOT_KEYS.forEach(key => setSlotModified(key, slotHasChanges(key)));
      updatePopupCharmRowStyles();
      if (popup && popup.isConnected) {
        updateCharmEffectDisplay(charmNet);
        updateWeaponClassDisplays();
      }
      refreshMaccCheckPanel();
    }

    function getCounterResistPanelDelta() {
      return getCharmNetEffects().counterResistPanel;
    }

    return { open, close, refresh, registerHandStatusEl, resetHandState, getCounterResistPanelDelta };
  })();    let hvutRowSyncObserver = null;
  let hvutRowSyncTimer = null;

  function stopHvutRowSync() {
    if (hvutRowSyncTimer !== null) {
      window.clearTimeout(hvutRowSyncTimer);
      hvutRowSyncTimer = null;
    }
    if (hvutRowSyncObserver) {
      hvutRowSyncObserver.disconnect();
      hvutRowSyncObserver = null;
    }
  }

  function startHvutRowSync() {
    if (hvutRowSyncObserver) return;
    if (!isEquipmentPage()) return;
    const syncNow = () => {
      if (!isEquipmentPage()) {
        stopHvutRowSync();
        return;
      }
      const containers = document.querySelectorAll('.hvut-eq-buttons');
      const btn = document.getElementById('hv-upgrade-btn');
      const first = containers[0];
      const btnInFirst = btn && first && first.contains(btn);
      if (containers.length && btn && (!btnInFirst || containers.length > 1)) {
        addUpgradeButton();
        return;
      }
      if (containers.length && btn && btnInFirst && containers.length === 1) {
        stopHvutRowSync();
      }
    };
    const schedule = () => {
      if (hvutRowSyncTimer !== null) window.clearTimeout(hvutRowSyncTimer);
      hvutRowSyncTimer = window.setTimeout(syncNow, 120);
    };
    const root = document.querySelector('#eqch_left') || document.body;
    hvutRowSyncObserver = new MutationObserver(schedule);
    hvutRowSyncObserver.observe(root, { childList: true, subtree: true });
    window.setTimeout(() => stopHvutRowSync(), 15000);
  }

  const EASTER_EGG_PRESETS = Object.freeze([
    '42',
    '⑨智爵士',
    '今日运势 大吉',
    '🍜*1000',
    '⑨月⑨日忆擅冻兄弟',
    'SAY YA~SAY YA~SAY YA~',
    '世界平和何で噓だ、皆独りぼっちだ',
    '私たちの未来へ、祝福を込めて',
    'DokiDoki WakuWaku',
    'KiraKira DokiDoki',
    'happy！lucky！smile！yeah！',
    'popipa！pipopa！popipapapipopa！',
    'U咩瓦帕瓦！',
    '也去试试HV Monster Manager吧',
    'KFC疯狂星期四V我50',
    '据说会使用火的只有人类☝️',
    '404 Not Found',
    '警钟长鸣: 单价1.2M买入19个秘银袋转手单价1.4M卖',
    '太合适了朋友，感觉这么好的装备就是为你准备的',
  ]);
  function addEasterEgg() {
    const oldEgg = document.getElementById('hv-easter-egg');
    if (oldEgg) oldEgg.remove();
    const container = document.getElementById('eqsb');
    if (!container) return;
    const egg = document.createElement('div');
    egg.id = 'hv-easter-egg';
    egg.textContent = EASTER_EGG_PRESETS[Math.floor(Math.random() * EASTER_EGG_PRESETS.length)];
    egg.title = '彩蛋';
    egg.style.cssText = [
      'position: absolute',
      'left: 4px',
      'bottom: 4px',
      'z-index: 99999',
      'font: 9pt Verdana, sans-serif',
      'color: #5C0D11',
      'opacity: 0.8',
      'pointer-events: none',
      'user-select: none',
      'white-space: nowrap',
    ].join('; ');
    container.appendChild(egg);
  }
  let initialized = false;
  function init() {
    if (!isEquipmentPage()) {
      removeUpgradeButton();
      return;
    }
    if (initialized) return;
    initialized = true;
    document.addEventListener('mouseover', event => {
      const equip = event.target?.closest?.('#eqsb [data-eid], #eqsb [onmouseover*="equips.set"]');
      if (equip) {
        const hoverEid = Number(equip.dataset.eid) || (equip.getAttribute('onmouseover') || '').match(/equips\.set\((\d+)/)?.[1] || null;
        if (hoverEid) lastHoveredEquipmentId = Number(hoverEid);
      }
    }, true);
    ensureEnglishStatsPanel();
    refreshMaccCheckPanel();
    addUpgradeButton();
    addEasterEgg();
    startHvutRowSync();
  }

  function watchEquipmentPageRoute() {
    let lastUrl = location.href;
    const sync = () => {
      if (location.href === lastUrl) return;
      lastUrl = location.href;
      if (isEquipmentPage()) {
        if (initialized) {
          addUpgradeButton();
          startHvutRowSync();
          refreshMaccCheckPanel();
          addEasterEgg();
        } else {
          init();
        }
      } else {
        removeUpgradeButton();
        stopHvutRowSync();
      }
    };

    window.addEventListener('popstate', sync);
    window.addEventListener('hashchange', sync);
    for (const method of ['pushState', 'replaceState']) {
      const original = history[method];
      if (typeof original !== 'function') continue;
      try {
        history[method] = function(...args) {
          const result = original.apply(this, args);
          sync();
          return result;
        };
      } catch (e) {}
    }
  }

  watchEquipmentPageRoute();
  if (document.readyState === 'complete') {
    init();
  } else {
    window.addEventListener('load', init);
  }

  try {
    const merged = window.__HV_MERGED_TOOLS__ || {};
    merged.materialPlanner = materialCalculator;
    window.__HV_MERGED_TOOLS__ = merged;
  } catch (err) {}

})();


(function () {
  "use strict";

  if (document.getElementById("hv-minsteps-launch")) return;

  // 融合计算按钮只在 Bazaar 融合相关子页面显示（?s=Bazaar&ss=am&screen=...），异世界（isekai）不显示
  const isIsekaiPage = /\/isekai(?:\/|$)/i.test(location.pathname || "") || /\/isekai\//i.test(location.href);
  const fusePage =
    !isIsekaiPage &&
    /(?:^|[?&])s=Bazaar(?:&|$)/i.test(location.search || "") &&
    /(?:^|[?&])ss=am(?:&|$)/i.test(location.search || "") &&
    /(?:^|[?&])screen=/.test(location.search || "");
  if (!fusePage) return;

  const SEARCH_DEFAULT_SECONDS = 10;
  const YIELD_EVERY_NODES = 1000;
  const STORAGE_KEY = "HV_FUSE_MINSTEPS_STATE_V1";
  const INPUTS_STORAGE_KEY = "HV_FUSE_MINSTEPS_INPUTS_V1";
  const MAX_SAVED_INPUTS = 30;
  const ACTION_PANEL_POSITION_KEY = "HV_FUSE_MINSTEPS_ACTION_PANEL_POSITION_V1";
  const ACTION_PANEL_DEFAULT_POSITION = { left: 1250, top: 340 };

  const QUALITY_RANGES = {
    Peerless: [200, 200],
    Legendary: [170, 200],
    Magnificent: [150, 180],
    Exquisite: [120, 160],
    Superior: [90, 130],
    Average: [60, 100],
    Fair: [30, 70],
    Crude: [0, 40],
  };
  const QUALITY_NAME_MAP = {
    无双: "Peerless",
    传奇: "Legendary",
    传说: "Legendary",
    史诗: "Magnificent",
    优良: "Exquisite",
    上等: "Superior",
  };
  const QUALITY_TERMS = Object.entries(QUALITY_NAME_MAP)
    .map(([term, quality]) => ({ term, quality }))
    .concat(Object.keys(QUALITY_RANGES).map((quality) => ({ term: quality, quality })))
    .sort((a, b) => b.term.length - a.term.length);

  const FUSE_CAP = {
    ONE_M: { credits: 1_000_000, label: "1M" },
    THREE_M: { credits: 3_000_000, label: "3M" },
    FIVE_M: { credits: 5_000_000, label: "5M" },
  };
  const FUSE_CAP_RULES = [
    { cap: "FIVE_M", label: "法杖", eqtKeys: ["staff", "法杖"] },
    { cap: "ONE_M", label: "盾牌", eqtKeys: ["shield", "盾牌"] },
    { cap: "THREE_M", label: "单手武器", eqtKeys: ["one-handed", "单手武器"] },
    { cap: "THREE_M", label: "双手武器", eqtKeys: ["two-handed", "双手武器"] },
    { cap: "ONE_M", label: "布甲", eqtKeys: ["cloth armor", "布甲"] },
    { cap: "ONE_M", label: "轻甲", eqtKeys: ["light armor", "轻甲"] },
    { cap: "ONE_M", label: "重甲", eqtKeys: ["heavy armor", "重甲"] },
  ];
  // 稀有材质：.eqt 只给大类（如 Cloth Armor），材质信息只能从装备名识别
  const RARE_MATERIAL_KEYS = ["phase", "shade", "power", "force", "相位", "暗影", "动力", "立场"];
  // 核心单价（c）：累计总价 = 融合总价 + 核心数量 × 核心单价
  const CORE_PRICE = 20000;

  const state = {
    allEquips: [],
    mainEquip: null,
    baseMainEquip: null,
    fuseEquip: null,
    attrKeys: [],
    fusionCount: 0,
    totalFusionCost: 0,
    totalCores: 0,
    busy: false,
    activeTab: "all",
    currentPlan: [],
    currentPlanMeta: null,
    savedInputId: "",
    conciseLog: [],
    pauseRequested: false,
    coreMarketPrice: true,   // 核心按市场价
    useCoreInventory: false, // 使用库存强化：核心消耗优先抵扣库存
    corePriceSource: "hvut", // 核心价格来源
  };

  const style = document.createElement("style");
  style.textContent = `
    #hv-minsteps-actions.hvut-side {
      position: fixed;
      left: 1250px;
      top: 340px;
      z-index: 99999;
      width: 85px;
      display: flex;
      flex-direction: column;
      box-sizing: content-box;
      margin: 0;
      padding: 10px 5px;
      border: 1px solid var(--color-border-default, #5c0d11);
      border-radius: 4px;
      background-color: var(--color-bg-default, #edebdf);
      box-shadow: 0 2px 6px rgba(0, 0, 0, .15);
      cursor: move;
      user-select: none;
    }
    #hv-minsteps-actions button {
      width: 100%;
      box-sizing: border-box;
      margin: 3px 0;
      padding: 1px;
      border: 2px solid var(--color-border-default, #5c0d11);
      border-radius: 5px;
      color: var(--color-font-default-alpha, #5c0d11bb);
      background-color: var(--color-bg-default, #edebda);
      cursor: pointer;
      font: bold 9pt Verdana, sans-serif;
      white-space: normal;
    }
    #hv-minsteps-actions button:hover,
    #hv-minsteps-actions button:focus {
      color: var(--color-font-light, #9b4e03);
      border-color: var(--color-border-light, #9b4e03);
      background-color: var(--color-bg-light, #eeede5);
    }
    #hv-minsteps-actions button:active {
      background: radial-gradient(#dfdacc, #f3f0e0);
      border-color: var(--color-border-light, #9b4e03);
    }
    #hv-minsteps-actions button:disabled {
      color: var(--color-font-invalid, #c2a8a4);
      border-color: var(--color-font-invalid, #c2a8a4);
      background-color: var(--color-bg-default, #edebda);
    }
    #hv-minsteps-panel {
      position: absolute;
      top: 80px;
      left: 250px;
      z-index: 9998;
      display: none;
      flex-direction: column;
      width: min(900px, calc(100vw - 28px));
      max-height: 85vh;
      overflow: hidden;
      padding: 0 10px 10px;
      color: #222;
      background: #f5f0e8;
      border: 2px solid #5c0d11;
      border-radius: 8px;
      box-shadow: 0 4px 8px rgba(0,0,0,.3);
      font: 10pt Verdana, sans-serif;
      user-select: text;
      cursor: default;
      box-sizing: border-box;
    }
    #hv-minsteps-panel.open { display: flex; }
    .hv-ms-header {
      position: relative;
      flex: 0 0 auto;
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 6px 10px;
      margin: 0 -10px 8px;
      color: #5c0d11;
      background: #d4cfc0;
      border-bottom: 2px solid #a47c78;
      border-radius: 8px 8px 0 0;
      cursor: move;
      user-select: none;
      font-weight: bold;
    }
    .hv-ms-header h2 { margin: 0; font-size: 11pt; }
    .hv-ms-close {
      width: 24px;
      height: 24px;
      padding: 0;
      color: #5c0d11;
      background: transparent;
      border: 0;
      font-size: 20px;
      line-height: 20px;
      cursor: pointer;
    }
    .hv-ms-body {
      flex: 1 1 auto;
      min-height: 0;
      padding: 0 0 10px;
      overflow-y: auto;
      overflow-x: hidden;
    }
    .hv-ms-toolbar,
    .hv-ms-actions {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 6px 10px;
      margin: 8px 0;
    }
    .hv-ms-toolbar button,
    .hv-ms-actions button {
      padding: 3px 8px;
      color: #fff;
      background: #5c0d11;
      border: 1px solid #5c0d11;
      border-radius: 3px;
      cursor: pointer;
      font: inherit;
    }
    .hv-ms-toolbar button:hover,
    .hv-ms-actions button:hover { background: #7b2028; }
    .hv-ms-toolbar button.secondary {
      color: #5c0d11;
      background: #e8e0d5;
      border-color: #b9aa99;
    }
    .hv-ms-toolbar button.secondary:hover { background: #d4cfc0; }
    .hv-ms-actions button.smart { background: #5c0d11; }
    .hv-ms-toolbar label {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      color: #222;
    }
    .hv-ms-toolbar input[type=number] {
      width: 38px;
      font: 10pt Verdana, sans-serif;
    }
    .hv-ms-grid {
      display: grid;
      grid-template-columns: minmax(260px, 1fr) minmax(430px, 2fr);
      gap: 10px;
    }
    .hv-ms-card {
      margin: 6px 0;
      padding: 0;
      background: transparent;
      border: 0;
    }
    .hv-ms-card h3 {
      margin: 8px 0 6px;
      padding: 4px 6px;
      color: #5c0d11;
      background: #d4cfc0;
      border-bottom: 2px solid #a47c78;
      border-radius: 3px 3px 0 0;
      font-size: 10pt;
    }
    .hv-ms-tabs {
      display: flex;
      gap: 4px;
      margin: 0 0 6px;
    }
    .hv-ms-tab {
      padding: 3px 9px;
      color: #5c0d11;
      background: #e8e0d5;
      border: 1px solid #b9aa99;
      border-radius: 3px;
      cursor: pointer;
      font: inherit;
    }
    .hv-ms-tab:hover { background: #d4cfc0; }
    .hv-ms-tab:focus,
    .hv-ms-tab:focus-visible {
      outline: none !important;
      box-shadow: none !important;
    }
    .hv-ms-tab.active,
    .hv-ms-tab.active:hover,
    .hv-ms-tab.active:focus,
    .hv-ms-tab.active:active {
      color: #fff !important;
      background: #5c0d11 !important;
      border-color: #5c0d11 !important;
    }
    .hv-ms-equip-id {
      border-bottom: 1px dotted #9b4e03;
      cursor: help;
    }
    .hv-ms-tip {
      position: fixed;
      z-index: 100000;
      display: none;
      max-width: 340px;
      padding: 5px 7px;
      color: #5c0d11;
      background: rgba(237, 235, 223, 0.97);
      border: 1px solid #5c0d11;
      border-radius: 3px;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
      font: 8pt Verdana, sans-serif;
      text-align: left;
      pointer-events: none;
    }
    .hv-ms-tip .hv-ms-tip-name {
      font-weight: bold;
      margin-bottom: 3px;
    }
    .hv-ms-tip .hv-ms-tip-attrs {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, auto));
      gap: 1px 10px;
      white-space: nowrap;
    }
    .hv-ms-list {
      height: 420px;
      min-height: 420px;
      max-height: 420px;
      margin: 0;
      padding: 0;
      overflow: auto;
      list-style: none;
      background: #fff8;
      border: 1px solid #b9aa99;
      border-radius: 2px;
      box-sizing: border-box;
    }
    .hv-ms-list li {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 3px 4px;
      border-bottom: 1px solid #d6cabb;
      cursor: pointer;
      word-break: break-word;
      text-align: left;
    }
    .hv-ms-list li:hover { background: #e8e0d5; }
    .hv-ms-list li.selected { background: #edb; }
    .hv-ms-list li.used {
      color: #777;
      background: #ece8e1;
      cursor: default;
    }
    .hv-ms-list li.used:hover { background: #ece8e1; }
    .hv-ms-equip-label {
      flex: 1 1 auto;
      min-width: 0;
      text-align: left;
      word-break: break-word;
    }
    .hv-ms-remove {
      flex: 0 0 20px;
      width: 20px;
      height: 20px;
      margin-left: auto;
      padding: 0;
      color: #5c0d11;
      background: transparent;
      border: 0;
      border-radius: 3px;
      cursor: pointer;
      font: bold 16px/18px Verdana, sans-serif;
      text-align: center;
    }
    .hv-ms-remove:hover {
      color: #fff;
      background: #5c0d11;
    }
    .hv-ms-select {
      width: 100%;
      padding: 3px 4px;
      background: #fff8;
      border: 1px solid #b9aa99;
      border-radius: 2px;
      font: 10pt Verdana, sans-serif;
    }
    .hv-ms-plan-toolbar {
      margin-top: 0;
    }
    #hv-minsteps-plan-select {
      flex: 0 1 150px;
      width: auto;
      min-width: 110px;
      max-width: 190px;
    }
    .hv-ms-toggle,
    .hv-ms-core-source-label {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      color: #222;
      white-space: nowrap;
      font: 10pt Verdana, sans-serif;
    }
    .hv-ms-core-source {
      width: auto;
      min-width: 110px;
    }
    .hv-ms-toolbar > .hv-ms-select {
      flex: 1 1 190px;
      width: auto;
      min-width: 160px;
    }
    .hv-ms-plan {
      max-height: 170px;
      margin: 6px 0;
      padding: 6px 8px;
      overflow: auto;
      color: #222;
      background: #fff8;
      border: 1px solid #b9aa99;
      line-height: 1.45;
    }
    .hv-ms-plan ol {
      margin: 4px 0 0 22px;
      padding: 0;
    }
    .hv-ms-plan li { padding: 1px 0; }
    .hv-ms-plan-meta {
      color: #5c0d11;
      font-weight: bold;
    }
    .hv-ms-plan-empty { color: #666; }
    .hv-ms-plan-label {
      color: #5c0d11;
      font-weight: bold;
      white-space: nowrap;
    }
    .hv-ms-toolbar > .hv-ms-plan {
      flex: 1 1 300px;
      min-width: 220px;
      max-width: 100%;
      max-height: 58px;
      margin: 0;
      padding: 3px 6px;
      display: flex;
      align-items: center;
      gap: 4px 8px;
      box-sizing: border-box;
    }
    .hv-ms-toolbar > .hv-ms-plan ol {
      display: flex;
      flex-wrap: wrap;
      gap: 0 12px;
      margin: 0 0 0 20px;
    }
    .hv-ms-toolbar > .hv-ms-plan li {
      padding: 0;
      white-space: nowrap;
    }
    .hv-ms-toolbar > .hv-ms-plan .hv-ms-plan-meta {
      white-space: nowrap;
    }
    .hv-ms-toast {
      position: fixed;
      left: 50%;
      bottom: 28px;
      z-index: 2147483647;
      max-width: min(460px, calc(100vw - 32px));
      padding: 8px 14px;
      color: #000;
      background: #e3e0d1;
      border: 1px solid #5c0d11;
      border-radius: 4px;
      box-shadow: 0 3px 12px rgba(0, 0, 0, .3);
      font: 10pt Verdana, sans-serif;
      opacity: 0;
      pointer-events: none;
      transform: translate(-50%, 10px);
      transition: opacity .18s ease, transform .18s ease;
    }
    .hv-ms-toast.show {
      opacity: 1;
      transform: translate(-50%, 0);
    }
    .hv-ms-toast.warn {
      color: #000;
      background: #e3e0d1;
      border-color: #5c0d11;
    }
    .hv-ms-attrs {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 4px 10px;
    }
    .hv-ms-attr { font-size: 10pt; word-break: break-word; }
    .hv-ms-attr em { color: #006400; font-style: normal; font-weight: bold; }
    .hv-ms-preview,
    .hv-ms-count {
      display: block;
      margin: 6px 0;
      padding: 6px 8px;
      color: #222;
      background: #fff8;
      border: 1px solid #b9aa99;
      font-weight: bold;
    }
    #hv-minsteps-cost {
      flex: 1 1 100%;
      box-sizing: border-box;
      white-space: pre-line;
    }
    .hv-ms-status-row {
      display: grid;
      grid-template-columns: minmax(260px, 1fr) minmax(430px, 2fr);
      gap: 10px;
      margin: 6px 0;
    }
    .hv-ms-status {
      box-sizing: border-box;
      min-width: 0;
      min-height: 21px;
      margin: 0;
      padding: 4px 8px;
      color: #555;
      background: #fff8;
      border: 1px solid #b9aa99;
      line-height: 1.4;
    }
    .hv-ms-status.warn {
      color: #b00020;
      background: #fff2f2;
      border-color: #b00020;
      font-weight: bold;
    }
    .hv-ms-status.ok { color: #006400; font-weight: bold; }
    .hv-ms-inventory {
      box-sizing: border-box;
      display: flex;
      align-items: center;
      min-width: 0;
      min-height: 21px;
      margin: 0;
      padding: 4px 8px;
      color: #5c0d11;
      background: #fff8;
      border: 1px solid #b9aa99;
      line-height: 1.4;
      font-size: 8pt;
      font-weight: bold;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .hv-ms-log {
      height: 175px;
      padding: 6px 8px;
      overflow: auto;
      white-space: pre-wrap;
      word-break: break-word;
      color: #222;
      background: #fff8;
      border: 1px solid #b9aa99;
      font: 9pt Consolas, monospace;
    }
    @media (max-width: 900px) {
      #hv-minsteps-panel {
        top: 70px;
        left: 7px;
        width: calc(100vw - 14px);
        max-height: calc(100vh - 14px);
      }
      .hv-ms-grid { grid-template-columns: 1fr; }
      .hv-ms-attrs { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
  `;
  document.head.appendChild(style);

  const panelHTML = `
    <button id="hv-minsteps-launch">融合计算</button>
    <section id="hv-minsteps-panel" aria-label="HV Fuse Minimum-Step Simulator">
      <div class="hv-ms-header">
        <h2>融合计算</h2>
        <button class="hv-ms-close" id="hv-minsteps-close">&times;</button>
      </div>
      <div class="hv-ms-body">
        <div class="hv-ms-toolbar">
          <button id="hv-minsteps-paste-main" class="secondary">主装备</button>
          <button id="hv-minsteps-paste-donors" class="secondary">库存装备</button>
          <button id="hv-minsteps-add-other" class="secondary">其他装备</button>
          <button id="hv-minsteps-reset-calculation" class="secondary">重置计算</button>
          <button id="hv-minsteps-reset" class="secondary">重置数据</button>
          <label>搜索时间
            <input id="hv-minsteps-time" type="number" min="1" max="300" step="1" value="${SEARCH_DEFAULT_SECONDS}">
            秒
          </label>
          <button id="hv-minsteps-pause" class="secondary" disabled>暂停</button>
          <label class="hv-ms-core-source-label">核心价格
            <select id="hv-minsteps-core-price-source" class="hv-ms-select hv-ms-core-source">
              <option value="hvut">HV Utils 保存价</option>
              <option value="ask">卖价 Ask</option>
              <option value="bid">买价 Bid</option>
              <option value="day">日均价</option>
              <option value="week">周均价</option>
              <option value="month">月均价</option>
              <option value="year">年均价</option>
            </select>
          </label>
        </div>
        <div class="hv-ms-toolbar hv-ms-plan-toolbar">
          <span class="hv-ms-plan-label">方案列表</span>
          <select id="hv-minsteps-plan-select" class="hv-ms-select" aria-label="方案列表">
            <option value=""></option>
          </select>
          <button id="hv-minsteps-save-plan" class="secondary">保存方案</button>
          <button id="hv-minsteps-delete-plan" class="secondary">删除方案</button>
          <button id="hv-minsteps-refresh-price" class="secondary">刷新价格</button>
          <button id="hv-minsteps-refresh-inventory" class="secondary">刷新库存</button>
          <label class="hv-ms-toggle"><input type="checkbox" id="hv-minsteps-core-market" checked> 核心按市场价</label>
          <label class="hv-ms-toggle"><input type="checkbox" id="hv-minsteps-core-inventory"> 使用库存强化</label>
        </div>
        <div class="hv-ms-status-row">
          <div class="hv-ms-inventory" id="hv-minsteps-inventory">核心：0｜L武器：0｜L法杖：0｜L护甲：0</div>
          <div class="hv-ms-status" id="hv-minsteps-status">请先导入装备数据。</div>
        </div>
        <div class="hv-ms-grid">
          <div>
            <div class="hv-ms-card">
              <h3>融合装备列表</h3>
              <div class="hv-ms-tabs" role="tablist" aria-label="融合装备分类">
                <button class="hv-ms-tab active" data-tab="all" role="tab">全部 <span id="hv-minsteps-tab-all-count">0</span></button>
                <button class="hv-ms-tab" data-tab="inventory" role="tab">库存 <span id="hv-minsteps-tab-inventory-count">0</span></button>
                <button class="hv-ms-tab" data-tab="other" role="tab">其他 <span id="hv-minsteps-tab-other-count">0</span></button>
                <button class="hv-ms-tab" data-tab="used" role="tab">已使用 <span id="hv-minsteps-tab-used-count">0</span></button>
              </div>
              <ul id="hv-minsteps-list" class="hv-ms-list"></ul>
            </div>
          </div>
          <div>
            <div class="hv-ms-card">
              <h3>融合操作</h3>
              <div class="hv-ms-actions">
                <button id="hv-minsteps-do">融合选择装备</button>
                <button id="hv-minsteps-beam" class="secondary">计算顺序</button>
                <button id="hv-minsteps-auto" class="smart">精确计算顺序</button>
                <button id="hv-minsteps-export-plan" class="secondary">导出方案</button>
                <span id="hv-minsteps-cost" class="hv-ms-count">当前装备上限：—｜已融合次数：0｜累计：0.000m</span>
              </div>
            </div>
            <div class="hv-ms-card">
              <h3>主装备</h3>
              <div id="hv-minsteps-main-name"><b>（未粘贴）</b></div>
              <div id="hv-minsteps-main-attrs" class="hv-ms-attrs"></div>
              <div id="hv-minsteps-main-preview" class="hv-ms-preview"></div>
            </div>
            <div class="hv-ms-card">
              <div id="hv-minsteps-fuse-name"><b>（未选择）</b></div>
              <div id="hv-minsteps-fuse-attrs" class="hv-ms-attrs"></div>
            </div>
            <div class="hv-ms-card">
              <h3>日志</h3>
              <div id="hv-minsteps-log" class="hv-ms-log"></div>
            </div>
          </div>
        </div>
      </div>
    </section>
  `;
  document.body.insertAdjacentHTML("beforeend", panelHTML);

  const launchButton = document.getElementById("hv-minsteps-launch");
  const actionPanel = document.createElement("div");
  actionPanel.id = "hv-minsteps-actions";
  actionPanel.className = "hvut-side hvut-am-side";
  actionPanel.setAttribute("aria-label", "HV 融合计算工具");
  launchButton?.classList.add("hvut-side-top");
  actionPanel.append(launchButton);
  document.body.appendChild(actionPanel);

  const equipTip = document.createElement("div");
  equipTip.id = "hv-minsteps-equip-tip";
  equipTip.className = "hv-ms-tip";
  document.body.appendChild(equipTip);

  const $ = (id) => document.getElementById(id);
  const panel = $("hv-minsteps-panel");
  const list = $("hv-minsteps-list");
  const tabButtons = [...document.querySelectorAll(".hv-ms-tab")];
  const tabAllCount = $("hv-minsteps-tab-all-count");
  const tabInventoryCount = $("hv-minsteps-tab-inventory-count");
  const tabOtherCount = $("hv-minsteps-tab-other-count");
  const tabUsedCount = $("hv-minsteps-tab-used-count");
  const mainName = $("hv-minsteps-main-name");
  const mainAttrs = $("hv-minsteps-main-attrs");
  const mainPreview = $("hv-minsteps-main-preview");
  const fuseName = $("hv-minsteps-fuse-name");
  const fuseAttrs = $("hv-minsteps-fuse-attrs");
  const cost = $("hv-minsteps-cost");
  const status = $("hv-minsteps-status");
  const inventoryBar = $("hv-minsteps-inventory");
  const logBox = $("hv-minsteps-log");
  let detailedLog = "";
  renderLog();
  const beamButton = $("hv-minsteps-beam");
  const autoButton = $("hv-minsteps-auto");
  const pauseButton = $("hv-minsteps-pause");
  const savePlanButton = $("hv-minsteps-save-plan");
  const deletePlanButton = $("hv-minsteps-delete-plan");
  const planSelector = $("hv-minsteps-plan-select");
  const exportPlanButton = $("hv-minsteps-export-plan");

  function setActionPanelPosition(target, position, persist = false) {
    if (!target) return;

    const panelWidth = target.offsetWidth || 95;
    const panelHeight = target.offsetHeight || 80;
    const maxLeft = Math.max(0, window.innerWidth - panelWidth);
    const maxTop = Math.max(0, window.innerHeight - panelHeight);
    const left = Math.min(maxLeft, Math.max(0, Number(position?.left)));
    const top = Math.min(maxTop, Math.max(0, Number(position?.top)));
    target.style.left = `${Math.round(Number.isFinite(left) ? left : ACTION_PANEL_DEFAULT_POSITION.left)}px`;
    target.style.top = `${Math.round(Number.isFinite(top) ? top : ACTION_PANEL_DEFAULT_POSITION.top)}px`;

    if (persist) saveActionPanelPosition(target);
  }

  function applySavedActionPanelPosition(target) {
    let position = ACTION_PANEL_DEFAULT_POSITION;
    const storage = getPageStorage();
    if (storage) {
      try {
        const saved = JSON.parse(storage.getItem(ACTION_PANEL_POSITION_KEY) || "null");
        if (saved && Number.isFinite(Number(saved.left)) && Number.isFinite(Number(saved.top))) {
          position = { left: Number(saved.left), top: Number(saved.top) };
        }
      } catch {
        // Ignore malformed cached position and use the default location.
      }
    }
    setActionPanelPosition(target, position);
  }

  function saveActionPanelPosition(target) {
    const storage = getPageStorage();
    if (!storage || !target) return;

    try {
      storage.setItem(
        ACTION_PANEL_POSITION_KEY,
        JSON.stringify({
          left: Number.parseFloat(target.style.left) || 0,
          top: Number.parseFloat(target.style.top) || 0,
        }),
      );
    } catch {
      // Storage may be disabled; the panel can still be dragged in memory.
    }
  }

  function detectQuality(name) {
    const text = String(name || "").replace(/\[[^\]]*\]/g, " ").replace(/\s+/g, " ").trim();
    for (const item of QUALITY_TERMS) {
      const pattern = item.term.length > 2
        ? new RegExp(`(^|[^A-Za-z])${item.term}([^A-Za-z]|$)`)
        : new RegExp(`(^|[^A-Za-z一-鿿])${item.term}([^A-Za-z一-鿿]|$)`);
      if (pattern.test(text)) return item.quality;
    }
    return "Legendary";
  }

  function qualityPercent(attrs, quality = "Legendary") {
    const range = QUALITY_RANGES[quality] || QUALITY_RANGES.Legendary;
    const [min, max] = range;
    const values = [];
    for (const value of Object.values(attrs || {})) {
      const number = Number(value);
      if (Number.isFinite(number)) values.push(number);
    }
    if (!values.length) return 0;

    const total = values.reduce((sum, base) => {
      if (max === min) return sum + (base >= max ? 100 : 0);
      return sum + ((base - min) / (max - min)) * 100;
    }, 0);
    return total / values.length;
  }

  function stripName(name) {
    return String(name || "").replace(/\[[^\]]*\]/g, " ").replace(/\s+/g, " ").trim();
  }

  // 去掉名称兜底：档位以 .eqt 类型文本为准；名称只用来识别稀有材质
  function detectFuseCap(eqtType = "", name = "") {
    const typeText = stripName(eqtType).toLowerCase();
    const nameText = stripName(name).toLowerCase();

    let typeRule = null;
    for (const rule of FUSE_CAP_RULES) {
      if (rule.eqtKeys.some((key) => typeText.includes(key))) {
        typeRule = rule;
        break;
      }
    }

    // 稀有材质（Phase/Shade/Power/Force）在对应大类下升为 3M
    if (typeRule && typeRule.cap === "ONE_M" && RARE_MATERIAL_KEYS.some((key) => nameText.includes(key))) {
      return { cap: "THREE_M", label: "稀有材质", capCredits: FUSE_CAP.THREE_M.credits };
    }

    if (typeRule) {
      return { cap: typeRule.cap, label: typeRule.label, capCredits: FUSE_CAP[typeRule.cap].credits };
    }

    // 新类型装备（.eqt 无法识别）不猜测档位，标记为未知，费用返回 null
    return { cap: null, label: "未知", capCredits: null };
  }

  function avgBaseOf(attrs, quality = "Legendary") {
    const percent = qualityPercent(attrs, quality);
    const range = QUALITY_RANGES[quality] || QUALITY_RANGES.Legendary;
    const [min, max] = range;
    if (max === min) return max;
    return min + ((max - min) / 100) * percent;
  }

  // 费用 = (上限/200) × round(平均Base)，其中平均Base由优秀度换算；缺少上限时返回 null
  function fuseCostCredits(attrs, quality = "Legendary", capCredits = 3_000_000) {
    if (!capCredits) return null;
    return (capCredits / 200) * Math.round(avgBaseOf(attrs, quality));
  }

  function isRareMaterialName(name) {
    const nameText = stripName(name).toLowerCase();
    return RARE_MATERIAL_KEYS.some((key) => nameText.includes(key));
  }

  // 核心消耗：素材每个 base 未大于主装备对应 base 则 +1；稀有材质装备再 +5；主装备该属性 base 为 200 时免核心
  function calcCoreCost(mainEquip, fuseEquip) {
    if (!mainEquip || !fuseEquip) return 0;

    let cores = 0;
    const keys = new Set([...Object.keys(mainEquip.attrs), ...Object.keys(fuseEquip.attrs)]);
    for (const key of keys) {
      const mainValue = Number(mainEquip.attrs[key] || 0);
      const fuseValue = Number(fuseEquip.attrs[key] || 0);
      if (mainValue === 200) continue;
      if (!(fuseValue > mainValue)) cores += 1;
    }
    if (isRareMaterialName(fuseEquip.name)) cores += 5;
    return cores;
  }

  function formatCostCompact(credits) {
    const number = Number(credits) || 0;
    return `${(number / 1_000_000).toFixed(3)}m`;
  }

  function formatCost(credits) {
    const number = Number(credits) || 0;
    return `${formatCostCompact(number)}（${Math.round(number).toLocaleString()} c）`;
  }

  class Equipment {
    constructor(id, name, attrs, source = "inventory", eqtType = "", equipUrl = "") {
      this.id = id;
      this.name = name;
      this.attrs = { ...attrs };
      this.source = source;
      this.equipUrl = equipUrl || "";
      this.used = false;
      this.quality = detectQuality(name);
      this.eqtType = eqtType;
      const detected = detectFuseCap(eqtType, name);
      this.fuseCap = detected.cap;
      this.fuseCapLabel = detected.label;
      this.fuseCapCredits = detected.capCredits;
    }

    toString() {
      return `${this.id} - ${this.name}`;
    }
  }

  function setStatus(message, type = "") {
    status.textContent = message;
    status.className = `hv-ms-status ${type}`.trim();
  }

  function renderLog() {
    const parts = ["[简略日志]"];
    if (state.conciseLog.length) parts.push(...state.conciseLog);
    parts.push("", "[详细日志]", detailedLog);
    logBox.textContent = parts.join("\n");
    logBox.scrollTop = 0;
  }

  function log(message) {
    detailedLog += `${message}\n`;
    renderLog();
  }

  function clearLog() {
    detailedLog = "";
    state.conciseLog = [];
    renderLog();
  }

  function readStoredPrices() {
    try {
      if (typeof GM_getValue === "function") {
        const value = GM_getValue("hvut_prices");
        if (value && typeof value === "object" && !Array.isArray(value)) return value;
      }
    } catch {}
    try {
      const value = JSON.parse(localStorage.getItem("hvut_prices"));
      return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    } catch {}
    return {};
  }

  // 融合消耗的核心类型：法杖→Staff，护甲/盾牌→Armor，其余武器→Weapon
  function mainCoreTypeName() {
    const type = String(state.mainEquip?.eqtType || state.mainEquip?.name || "").toLowerCase();
    if (type.includes("staff")) return "Staff";
    if (type.includes("shield") || type.includes("armor")) return "Armor";
    if (type.includes("weapon") || type.includes("hand")) return "Weapon";
    return "Armor";
  }

  // 核心单价：勾选“核心按市场价”时读取所选来源的保存价，否则用固定价
  function getCoreUnitPrice() {
    if (!state.coreMarketPrice) return CORE_PRICE;
    const key = `Legendary ${mainCoreTypeName()} Core`;
    const market = Number(readStoredPrices()[key]);
    return Number.isFinite(market) && market > 0 ? market : CORE_PRICE;
  }

  function updateCount() {
    updateInventoryBar();
    if (!state.mainEquip) {
      cost.textContent = "当前装备上限：—｜已融合次数：0｜累计：0.000m";
      return;
    }
    const capShow = FUSE_CAP[state.mainEquip.fuseCap]?.label || state.mainEquip.fuseCapLabel || "未知";
    const unitPrice = getCoreUnitPrice();
    const inventoryCores = state.useCoreInventory ? getCoreInventory().total : 0;
    const pricedCores = Math.max(0, state.totalCores - inventoryCores);
    const deducted = state.totalCores - pricedCores;
    const totalPrice = state.totalFusionCost + pricedCores * unitPrice;
    const invPart = state.useCoreInventory && deducted > 0 ? `，库存抵扣${deducted}` : "";
    cost.textContent = `当前装备上限：${capShow}｜已融合次数：${state.fusionCount}｜累计：${formatCostCompact(totalPrice)}\n（融合${formatCostCompact(state.totalFusionCost)}＋${pricedCores}核心×${unitPrice.toLocaleString()}c${invPart}）`;
  }

  function getCoreInventory() {
    const planner = window.__HV_MERGED_TOOLS__?.materialPlanner;
    const inventory = (planner && typeof planner.getInventory === "function") ? planner.getInventory() : {};
    const amount = (name) => Number(inventory[name]) || 0;
    return {
      total: amount("Legendary Weapon Core") + amount("Peerless Weapon Core")
        + amount("Legendary Staff Core") + amount("Peerless Staff Core")
        + amount("Legendary Armor Core") + amount("Peerless Armor Core"),
      weapon: amount("Legendary Weapon Core"),
      staff: amount("Legendary Staff Core"),
      armor: amount("Legendary Armor Core"),
    };
  }

  function updateInventoryBar() {
    if (!inventoryBar) return;
    const cores = getCoreInventory();
    inventoryBar.textContent = `核心：${cores.total}｜L武器：${cores.weapon}｜L法杖：${cores.staff}｜L护甲：${cores.armor}`;
  }

  async function refreshPrice() {
    if (state.busy) {
      showToast("搜索进行中，暂时不能刷新价格。", "warn");
      return;
    }
    const planner = window.__HV_MERGED_TOOLS__?.materialPlanner;
    if (planner && typeof planner.refreshPrices === "function") {
      state.busy = true;
      try {
        setStatus("正在刷新市场价格……");
        await planner.refreshPrices(state.corePriceSource);
        updateCount();
        setStatus("市场价格已刷新。", "ok");
        showToast("市场价格已刷新。");
      } catch (error) {
        setStatus(`价格刷新失败：${error.message || "读取失败"}`, "warn");
        showToast("价格刷新失败。", "warn");
      } finally {
        state.busy = false;
      }
      return;
    }
    if (!state.mainEquip) {
      showToast("请先设置主装备。", "warn");
      return;
    }
    const url = state.mainEquip.equipUrl || "";
    if (!url) {
      showToast("主装备缺少完整链接，无法刷新价格，请重新导入主装备。", "warn");
      return;
    }
    state.busy = true;
    try {
      setStatus("正在刷新主装备价格……");
      const html = await requestEquipmentHtml(url);
      const refreshed = parseEquipmentPage(html, state.mainEquip.id, url);
      refreshed.source = "main";
      refreshed.equipUrl = url;
      state.mainEquip = refreshed;
      state.baseMainEquip = cloneEquipment(refreshed, "main");
      state.attrKeys = Object.keys(refreshed.attrs);
      state.fuseEquip = null;
      updateCount();
      refreshUI();
      saveState();
      setStatus("价格已刷新。", "ok");
      showToast("价格已刷新。");
    } catch (error) {
      setStatus(`价格刷新失败：${error.message || "读取失败"}`, "warn");
      showToast("价格刷新失败。", "warn");
    } finally {
      state.busy = false;
    }
  }

  async function refreshInventory() {
    if (state.busy) {
      showToast("搜索进行中，暂时不能刷新库存。", "warn");
      return;
    }
    const planner = window.__HV_MERGED_TOOLS__?.materialPlanner;
    if (planner && typeof planner.refreshInventory === "function") {
      state.busy = true;
      try {
        setStatus("正在读取库存……");
        await planner.refreshInventory();
        updateInventoryBar();
        setStatus("库存已刷新。", "ok");
        showToast("库存已刷新。");
      } catch (error) {
        setStatus(`库存刷新失败：${error.message || "读取失败"}`, "warn");
        showToast("库存刷新失败。", "warn");
      } finally {
        state.busy = false;
      }
      return;
    }
    const rows = [...document.querySelectorAll("#equiplist tr[data-eid][data-key]")];
    if (!rows.length) {
      showToast("当前页面没有装备列表（需在 HV 装备页面使用）。", "warn");
      return;
    }

    const byId = new Map(state.allEquips.map((equip) => [String(equip.id), equip]));
    const urlsToFetch = [];
    let updated = 0;
    for (const row of rows) {
      const id = row.getAttribute("data-eid");
      const key = row.getAttribute("data-key");
      if (!id || !key) continue;
      const url = `https://hentaiverse.org/equip/${id}/${key}`;
      const existing = byId.get(id);
      if (existing) {
        if (existing.equipUrl !== url) {
          existing.equipUrl = url;
          updated += 1;
        }
        continue;
      }
      urlsToFetch.push(url);
    }

    const loaded = [];
    const failed = [];
    if (urlsToFetch.length) {
      state.busy = true;
      try {
        const fetched = await fetchEquipmentLinks(urlsToFetch, "inventory", "库存装备");
        loaded.push(...fetched.loaded);
        failed.push(...fetched.failed);
      } finally {
        state.busy = false;
      }
    }

    let added = 0;
    for (const equip of loaded) {
      if (equip.id === state.mainEquip?.id) continue;
      byId.set(String(equip.id), equip);
      added += 1;
    }
    state.allEquips = [...byId.values()];
    if (!state.attrKeys.length && state.allEquips.length) {
      state.attrKeys = Object.keys(state.allEquips[0].attrs);
    }
    refreshUI();
    saveState();
    updateInventoryBar();

    const summary = `库存已刷新：新增 ${added} 件，更新链接 ${updated} 件${failed.length ? `，失败 ${failed.length} 件` : ""}。`;
    setStatus(summary, failed.length ? "warn" : "ok");
    showToast(summary);
  }

  function serializePlanStep(step) {
    if (!step || !Number.isInteger(Number(step.id))) return null;
    return {
      id: Number(step.id),
      name: String(step.name || `装备 ${step.id}`),
    };
  }

  function deserializePlanSteps(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.map(serializePlanStep).filter(Boolean);
  }

  function normalizePlanMeta(raw, fallbackSteps) {
    const source = raw && typeof raw === "object" ? raw : {};
    const steps = Number(source.steps);
    const nodes = Number(source.nodes);
    return {
      steps: Number.isFinite(steps) ? Math.max(0, Math.floor(steps)) : fallbackSteps,
      proven: source.proven === true,
      timedOut: source.timedOut === true,
      elapsed: typeof source.elapsed === "string" ? source.elapsed : "",
      nodes: Number.isFinite(nodes) ? Math.max(0, Math.floor(nodes)) : 0,
      kind: ["manual", "beam"].includes(source.kind) ? source.kind : "auto",
    };
  }

  function readSavedInputs() {
    const storage = getPageStorage();
    if (!storage) return [];

    try {
      const raw = storage.getItem(INPUTS_STORAGE_KEY);
      if (!raw) return [];
      const saved = JSON.parse(raw);
      if (!Array.isArray(saved)) return [];

      return saved.map((plan) => {
        if (!plan || !plan.id || !plan.name) return null;
        const mainEquip = deserializeEquipment(plan.mainEquip, "main");
        if (!mainEquip) return null;
        const allEquips = Array.isArray(plan.allEquips)
          ? plan.allEquips
            .map((item) => deserializeEquipment(item, "inventory"))
            .filter(Boolean)
            .filter((equip) => equip.id !== mainEquip.id)
          : [];
        const attrKeys = Array.isArray(plan.attrKeys) && plan.attrKeys.length
          ? plan.attrKeys.filter((key) => typeof key === "string" && key)
          : Object.keys(mainEquip.attrs);
        return {
          id: String(plan.id),
          name: String(plan.name),
          mainEquip,
          allEquips,
          attrKeys,
          savedAt: Number.isFinite(Number(plan.savedAt)) ? Number(plan.savedAt) : 0,
        };
      }).filter(Boolean);
    } catch {
      return [];
    }
  }

  function writeSavedInputs(inputs) {
    const storage = getPageStorage();
    if (!storage) return false;

    try {
      storage.setItem(INPUTS_STORAGE_KEY, JSON.stringify(inputs));
      return true;
    } catch {
      return false;
    }
  }

  function updateInputSelector() {
    const savedInputs = readSavedInputs();
    planSelector.replaceChildren();

    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = savedInputs.length ? "" : "暂无方案";
    placeholder.disabled = savedInputs.length > 0;
    placeholder.hidden = savedInputs.length > 0;
    planSelector.appendChild(placeholder);

    for (const input of savedInputs) {
      const option = document.createElement("option");
      option.value = input.id;
      option.textContent = input.name;
      planSelector.appendChild(option);
    }

    if (savedInputs.some((input) => input.id === state.savedInputId)) {
      planSelector.value = state.savedInputId;
    } else {
      state.savedInputId = "";
      planSelector.value = "";
    }
  }

  function setCurrentPlan(steps, meta = null) {
    state.currentPlan = deserializePlanSteps(steps);
    state.currentPlanMeta = meta ? normalizePlanMeta(meta, state.currentPlan.length) : null;
    updateInputSelector();
  }

  function saveInputData() {
    if (!state.mainEquip) {
      showToast("请先输入主装备数据。", "warn");
      return;
    }

    const inputMainEquip = state.baseMainEquip || state.mainEquip;
    const defaultName = inputMainEquip
      ? `${inputMainEquip.name} - ${state.allEquips.length}件融合装备`
      : `装备数据 ${new Date().toLocaleString()}`;
    const input = prompt("请输入方案名称（保存主装备和融合装备）：", defaultName);
    if (input === null) return;

    const name = input.trim().slice(0, 80) || defaultName;
    const savedInputs = readSavedInputs();
    const sameIndex = savedInputs.findIndex((item) => item.name === name);
    const existing = sameIndex >= 0 ? savedInputs[sameIndex] : null;
    const record = {
      id: existing?.id || `input-${Date.now().toString(36)}`,
      name,
      mainEquip: serializeEquipment(inputMainEquip, false),
      allEquips: state.allEquips.map((equip) => serializeEquipment(equip, false)),
      attrKeys: state.attrKeys,
      savedAt: Date.now(),
    };
    const nextPlans = sameIndex >= 0
      ? savedInputs.map((item, index) => (index === sameIndex ? record : item))
      : [record, ...savedInputs].slice(0, MAX_SAVED_INPUTS);

    if (!writeSavedInputs(nextPlans)) {
      showToast("输入数据保存失败，浏览器存储可能不可用。", "warn");
      return;
    }

    state.savedInputId = record.id;
    updateInputSelector();
    saveState();
    showToast(`方案“${name}”保存成功。`);
  }

  function loadSavedInputData() {
    if (state.busy) {
      showToast("搜索进行中，暂时不能读取输入数据。", "warn");
      return;
    }

    const inputId = planSelector.value;
    if (!inputId) return;

    const savedInput = readSavedInputs().find((item) => item.id === inputId);
    if (!savedInput) {
      updateInputSelector();
      showToast("找不到要读取的输入数据。", "warn");
      return;
    }

    state.mainEquip = cloneEquipment(savedInput.mainEquip, "main");
    state.baseMainEquip = cloneEquipment(savedInput.mainEquip, "main");
    state.allEquips = savedInput.allEquips;
    state.attrKeys = savedInput.attrKeys;
    state.fuseEquip = null;
    state.fusionCount = 0;
    state.totalFusionCost = 0;
    state.totalCores = 0;
    state.activeTab = "all";
    state.currentPlan = [];
    state.currentPlanMeta = null;
    state.savedInputId = savedInput.id;
    clearLog();
    updateCount();
    refreshUI();
    updateInputSelector();
    saveState();
    setStatus(`已读取输入数据：${savedInput.name}。`, "ok");
    showToast(`已读取输入数据“${savedInput.name}”。`);
  }

  function deleteSavedInputData() {
    if (state.busy) {
      showToast("搜索进行中，暂时不能删除方案。", "warn");
      return;
    }

    const inputId = planSelector.value;
    if (!inputId) {
      showToast("请先在方案列表中选择要删除的方案。", "warn");
      return;
    }

    const savedInputs = readSavedInputs();
    const savedInput = savedInputs.find((item) => item.id === inputId);
    if (!savedInput) {
      updateInputSelector();
      showToast("找不到要删除的方案。", "warn");
      return;
    }

    if (!confirm(`确定删除方案“${savedInput.name}”吗？`)) return;

    const nextInputs = savedInputs.filter((item) => item.id !== inputId);
    if (!writeSavedInputs(nextInputs)) {
      showToast("方案删除失败，浏览器存储可能不可用。", "warn");
      return;
    }

    state.savedInputId = "";
    updateInputSelector();
    saveState();
    showToast(`方案“${savedInput.name}”已删除。`);
  }

  function getPageStorage() {
    try {
      const pageWindow = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
      return pageWindow.localStorage;
    } catch {
      return null;
    }
  }

  function serializeEquipment(equip, includeUsed = true) {
    return {
      id: equip.id,
      equipUrl: equip.equipUrl || "",
      name: equip.name,
      attrs: { ...equip.attrs },
      source: equip.source === "other" ? "other" : "inventory",
      used: includeUsed && equip.used === true,
      quality: equip.quality || detectQuality(equip.name),
      eqtType: equip.eqtType || "",
      fuseCap: equip.fuseCap || null,
      fuseCapLabel: equip.fuseCapLabel || null,
      fuseCapCredits: equip.fuseCapCredits || null,
    };
  }

  function deserializeEquipment(raw, defaultSource) {
    if (!raw || !Number.isInteger(Number(raw.id)) || !raw.attrs || typeof raw.attrs !== "object") return null;

    const attrs = {};
    for (const [key, value] of Object.entries(raw.attrs)) {
      const number = Number(value);
      if (key && Number.isFinite(number)) attrs[key] = number;
    }
    if (!Object.keys(attrs).length) return null;

    const source = defaultSource === "main" ? "main" : raw.source === "other" ? "other" : "inventory";
    const equip = new Equipment(Number(raw.id), String(raw.name || `装备 ${raw.id}`), attrs, source, String(raw.eqtType || ""), String(raw.equipUrl || ""));
    equip.used = defaultSource !== "main" && raw.used === true;
    equip.quality = raw.quality || detectQuality(equip.name);
    // 旧缓存没有 eqtType：不按名称猜测，标记为未知
    if (raw.fuseCapCredits && FUSE_CAP[raw.fuseCap]) {
      equip.fuseCap = raw.fuseCap;
      equip.fuseCapLabel = raw.fuseCapLabel || "未知";
      equip.fuseCapCredits = Number(raw.fuseCapCredits);
    }
    return equip;
  }

  function cloneEquipment(equip, source = equip?.source || "inventory") {
    if (!equip) return null;
    const clone = new Equipment(equip.id, equip.name, equip.attrs, source, equip.eqtType || "", equip.equipUrl || "");
    clone.used = source !== "main" && equip.used === true;
    return clone;
  }

  function recoverBaseMainEquip(equip, logText) {
    const base = cloneEquipment(equip, "main");
    if (!base || typeof logText !== "string") return base;

    const lines = logText.split(/\r?\n/);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const match = lines[index].match(/^\s{2}(.+?):\s*(-?\d+)\s*→\s*(-?\d+)/);
      if (!match) continue;

      const key = match[1].trim();
      if (Object.prototype.hasOwnProperty.call(base.attrs, key)) {
        base.attrs[key] = Number(match[2]);
      }
    }
    return base;
  }

  function saveState() {
    const storage = getPageStorage();
    if (!storage) return;

    try {
      storage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          mainEquip: state.mainEquip ? serializeEquipment(state.mainEquip) : null,
          baseMainEquip: state.baseMainEquip ? serializeEquipment(state.baseMainEquip, false) : null,
          allEquips: state.allEquips.map(serializeEquipment),
          attrKeys: state.attrKeys,
          fusionCount: state.fusionCount,
          totalFusionCost: state.totalFusionCost,
          totalCores: state.totalCores,
          activeTab: state.activeTab,
          fuseEquipId: state.fuseEquip?.id ?? null,
          currentPlan: state.currentPlan.map(serializePlanStep).filter(Boolean),
          currentPlanMeta: state.currentPlanMeta,
          savedInputId: state.savedInputId,
          coreMarketPrice: state.coreMarketPrice,
          useCoreInventory: state.useCoreInventory,
          corePriceSource: state.corePriceSource,
          log: detailedLog,
          conciseLog: state.conciseLog.map(String),
        }),
      );
    } catch {
      // Storage may be disabled or full; the simulator can continue in memory.
    }
  }

  function restoreState() {
    const storage = getPageStorage();
    if (!storage) {
      updateCount();
      clearInfo();
      setStatus("请先设置主装备，再添加库存或其他装备。");
      return;
    }

    try {
      const raw = storage.getItem(STORAGE_KEY);
      if (!raw) {
        updateCount();
        clearInfo();
        setStatus("请先设置主装备，再添加库存或其他装备。");
        return;
      }

      const saved = JSON.parse(raw);
      const mainEquip = deserializeEquipment(saved.mainEquip, "main");
      const savedLog = typeof saved.log === "string" ? saved.log : "";
      const baseMainEquip = deserializeEquipment(saved.baseMainEquip, "main")
        || recoverBaseMainEquip(mainEquip, savedLog);
      const allEquips = Array.isArray(saved.allEquips)
        ? saved.allEquips.map((item) => deserializeEquipment(item, "inventory")).filter(Boolean)
        : [];

      state.mainEquip = mainEquip;
      state.baseMainEquip = baseMainEquip;
      state.allEquips = allEquips.filter((equip) => equip.id !== state.mainEquip?.id);
      state.fuseEquip = state.allEquips.find((equip) => equip.id === Number(saved.fuseEquipId)) || null;
      state.attrKeys = Array.isArray(saved.attrKeys) && saved.attrKeys.length
        ? saved.attrKeys
        : mainEquip
          ? Object.keys(mainEquip.attrs)
          : state.allEquips.length
            ? Object.keys(state.allEquips[0].attrs)
            : [];
      state.fusionCount = Number.isFinite(Number(saved.fusionCount)) ? Number(saved.fusionCount) : 0;
      state.totalFusionCost = Number.isFinite(Number(saved.totalFusionCost)) ? Number(saved.totalFusionCost) : 0;
      state.totalCores = Number.isFinite(Number(saved.totalCores)) ? Number(saved.totalCores) : 0;
      state.activeTab = ["all", "inventory", "other", "used"].includes(saved.activeTab) ? saved.activeTab : "all";
      state.currentPlan = deserializePlanSteps(saved.currentPlan);
      state.currentPlanMeta = saved.currentPlanMeta
        ? normalizePlanMeta(saved.currentPlanMeta, state.currentPlan.length)
        : null;
      state.savedInputId = typeof saved.savedInputId === "string" ? saved.savedInputId : "";
      state.coreMarketPrice = saved.coreMarketPrice !== false;
      state.useCoreInventory = saved.useCoreInventory === true;
      state.corePriceSource = typeof saved.corePriceSource === "string" ? saved.corePriceSource : "hvut";
      clearLog();
      detailedLog = savedLog;
      state.conciseLog = Array.isArray(saved.conciseLog) ? saved.conciseLog.map(String) : [];
      renderLog();
      updateCount();
      refreshUI();
      updateInputSelector();
      saveState();
      setStatus(`已恢复缓存：${state.mainEquip ? "1 件主装备，" : ""}${state.allEquips.length} 件融合装备。`, "ok");
    } catch {
      storage.removeItem(STORAGE_KEY);
      updateCount();
      clearInfo();
      setStatus("缓存读取失败，已清除损坏缓存。", "warn");
    }
  }

  function cleanName(name) {
    return name.replace(/^\d+\s+/, "").replace(/^\+/, "").trim();
  }

  async function copyText(text) {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }

    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    textarea.remove();
    if (!copied) throw new Error("copy failed");
  }

  function normalizeAttributeName(name) {
    let normalized = cleanName(name.replace(/\s+/g, " "));
    if (["Crushing Damage", "Slashing Damage", "Piercing Damage", "Void Damage"].includes(normalized)) {
      normalized = "Physical Damage";
    }
    if (normalized === "Spell Damage") normalized = "Magic Damage";
    return normalized;
  }

  function parseEquipmentUrl(rawValue) {
    const value = rawValue.trim();
    if (!value) throw new Error("链接为空");

    let url;
    try {
      url = new URL(value, location.href);
    } catch {
      throw new Error("链接格式无效");
    }

    if (!/^https?:$/i.test(url.protocol) || !/(^|\.)hentaiverse\.org$/i.test(url.hostname)) {
      throw new Error("链接必须来自 hentaiverse.org");
    }

    const match = url.pathname.match(/\/(?:isekai\/)?equip\/(\d+)(?:\/[^/]+)?/i);
    if (!match) throw new Error("没有识别到装备链接中的装备编号");

    return { url: url.href, id: Number.parseInt(match[1], 10) };
  }

  function buildEquipUrlFromPage(id) {
    const row = document.querySelector(`#equiplist tr[data-eid="${id}"][data-key]`);
    if (row) {
      const key = row.getAttribute("data-key");
      if (key) return `https://hentaiverse.org/equip/${id}/${key}`;
    }
    const pattern = new RegExp(`/equip/${id}/[^/?#]+`, "i");
    for (const link of document.querySelectorAll('a[href*="/equip/"]')) {
      const href = link.getAttribute("href") || "";
      if (pattern.test(href)) return href;
    }
    return "";
  }

  function backfillEquipmentUrls() {
    const seen = new Set();
    let changed = false;
    const candidates = [...state.allEquips];
    if (state.mainEquip) candidates.push(state.mainEquip, state.baseMainEquip);
    for (const equip of candidates) {
      if (!equip || seen.has(equip.id)) continue;
      seen.add(equip.id);
      if (equip.equipUrl) continue;
      const url = buildEquipUrlFromPage(equip.id);
      if (url) {
        equip.equipUrl = url;
        changed = true;
      }
    }
    if (changed) saveState();
  }

  function requestEquipmentHtml(url) {
    if (typeof GM_xmlhttpRequest === "function") {
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: "GET",
          url,
          onload: (response) => {
            if (response.status >= 200 && response.status < 400) resolve(response.responseText);
            else reject(new Error(`服务器返回状态 ${response.status}`));
          },
          onerror: () => reject(new Error("网络请求失败")),
          ontimeout: () => reject(new Error("网络请求超时")),
        });
      });
    }

    return fetch(url, { credentials: "include" }).then((response) => {
      if (!response.ok) throw new Error(`服务器返回状态 ${response.status}`);
      return response.text();
    });
  }

  function parseEquipmentPage(html, id, fallbackUrl = "") {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const root = doc.querySelector(".showequip") || doc;
    let name = "";
    const equipLinks = Array.from(root.querySelectorAll("a[href]"));
    const idLink = equipLinks.find((link) => {
      const href = link.getAttribute("href") || "";
      return /\/equip\/\d+/.test(href) && href.includes(`/equip/${id}`);
    }) || equipLinks.find((link) => /\/equip\/\d+/.test(link.getAttribute("href") || ""));
    if (idLink) {
      name = String(idLink.textContent || "").replace(/\s+/g, " ").trim();
    }
    if (!name) {
      const firstDiv = root.querySelector(".showequip > div:first-child, #popup_box > div:first-child");
      if (firstDiv) name = String(firstDiv.textContent || "").replace(/\s+/g, " ").trim();
    }
    if (!name) name = String(id);
    const eqtNode = doc.querySelector(".eqt");
    const eqtType = eqtNode
      ? String(eqtNode.textContent || "")
          .replace(/<[^>]*>/g, " ")
          .replace(/&nbsp;|&#160;/gi, " ")
          .replace(/\s+/g, " ")
          .trim()
          .replace(/\s*(?:Level|Tier)\s*\d+[^ ]*(?:\s*\/\s*\d+)*.*$/i, "")
          .trim()
      : "";
    const attrs = {};

    root.querySelectorAll('[title*="Base"]').forEach((node) => {
      const title = node.getAttribute("title") || "";
      const match = title.match(/Base:\s*(\d+)/);
      if (!match) return;

      const rawName = node.firstElementChild?.textContent?.trim() || node.querySelector("span")?.textContent?.trim();
      if (!rawName) return;

      const attrName = normalizeAttributeName(rawName);
      if (attrName) attrs[attrName] = Number.parseInt(match[1], 10);
    });

    if (!Object.keys(attrs).length) throw new Error("页面中没有识别到带 Base 数值的装备属性");
    const equip = new Equipment(id, name, attrs, "other", eqtType, fallbackUrl);
    return equip;
  }

  function extractEquipmentLinks(text) {
    const candidates = [];
    const urlPattern = /https?:\/\/[^\s\]]+/gi;
    let match;

    while ((match = urlPattern.exec(text)) !== null) candidates.push(match[0]);
    candidates.push(...text.split(/\s+/));

    return [...new Set(
      candidates
        .map((value) => value.trim().replace(/^[<([{]+/, "").replace(/[),\]}>，。；;]+$/g, ""))
        .filter((value) => /^(?:https?:\/\/|\/)/i.test(value))
        .filter((value) => /\/(?:isekai\/)?equip\/\d+/i.test(value)),
    )];
  }

  async function fetchEquipmentLinks(links, source, label) {
    const loaded = [];
    const failed = [];

    for (let index = 0; index < links.length; index += 1) {
      try {
        const info = parseEquipmentUrl(links[index]);
        setStatus(`正在读取${label} ${index + 1}/${links.length}……`);
        const html = await requestEquipmentHtml(info.url);
        const equip = parseEquipmentPage(html, info.id, info.url);
        equip.source = source;
        loaded.push(equip);
      } catch (error) {
        failed.push(`${links[index]}：${error.message || "读取失败"}`);
      }
    }

    return { loaded, failed };
  }

  function logInputFailures(label, failed) {
    if (failed.length) {
      log(`${label}读取失败 ${failed.length} 件：\n${failed.join("\n")}`);
    }
  }

  async function fetchFromText(text, source, label) {
    const links = extractEquipmentLinks(text);
    if (!links.length) return null;
    state.busy = true;
    try {
      return await fetchEquipmentLinks(links, source, label);
    } finally {
      state.busy = false;
    }
  }

  async function loadMainInput(text) {
    if (state.busy) return;

    const fetched = await fetchFromText(text, "main", "主装备");
    if (!fetched) {
      setStatus("没有识别到主装备数据或链接。", "warn");
      return;
    }

    const equips = fetched.loaded;
    if (!equips.length) {
      logInputFailures("主装备", fetched.failed);
      setStatus("没有找到可用的主装备。", "warn");
      return;
    }

    loadMainEquip(equips);
    if (fetched.failed.length) {
      logInputFailures("主装备", fetched.failed);
      setStatus(`主装备已载入，但有 ${fetched.failed.length} 个链接读取失败。`, "warn");
      saveState();
    }
  }

  async function loadInventoryInput(text) {
    if (state.busy) return;

    const fetched = await fetchFromText(text, "inventory", "库存装备");
    if (!fetched) {
      setStatus("没有识别到库存装备数据或链接。", "warn");
      return;
    }

    const byId = new Map();
    for (const equip of fetched.loaded) {
      if (equip.id !== state.mainEquip?.id) byId.set(equip.id, equip);
    }
    const equips = [...byId.values()];
    if (!equips.length) {
      logInputFailures("库存装备", fetched.failed);
      setStatus("没有找到可用的库存装备。", "warn");
      return;
    }

    loadDonorEquips(equips);
    if (fetched.failed.length) {
      logInputFailures("库存装备", fetched.failed);
      setStatus(`库存装备已载入，但有 ${fetched.failed.length} 个链接读取失败。`, "warn");
      saveState();
    }
  }

  async function loadOtherInput(text) {
    if (state.busy) return;

    const fetched = await fetchFromText(text, "other", "其他装备");
    if (!fetched) {
      setStatus("没有识别到其他装备数据或链接。", "warn");
      return;
    }

    const blockedIds = new Set([
      state.mainEquip?.id,
      ...state.allEquips.filter((equip) => equip.source === "inventory").map((equip) => equip.id),
    ]);
    const otherById = new Map(
      state.allEquips
        .filter((equip) => equip.source === "other")
        .map((equip) => [equip.id, equip]),
    );
    let added = 0;
    for (const equip of fetched.loaded) {
      if (blockedIds.has(equip.id)) continue;
      otherById.set(equip.id, equip);
      added += 1;
    }

    if (!added) {
      logInputFailures("其他装备", fetched.failed);
      setStatus("没有成功添加其他装备。", "warn");
      return;
    }

    state.allEquips = [
      ...state.allEquips.filter((equip) => equip.source === "inventory"),
      ...otherById.values(),
    ];
    resetProgress();
    state.activeTab = "other";
    refreshUI();
    logInputFailures("其他装备", fetched.failed);
    saveState();

    if (fetched.failed.length) {
      setStatus(`已添加 ${added} 件其他装备，但有 ${fetched.failed.length} 个链接读取失败。`, "warn");
    }
  }

  function resetProgress() {
    state.fuseEquip = null;
    state.fusionCount = 0;
    state.totalFusionCost = 0;
    state.totalCores = 0;
    state.currentPlan = [];
    state.currentPlanMeta = null;
    state.savedInputId = "";
    clearLog();
    updateCount();
    updateInputSelector();
  }

  function loadMainEquip(equips) {
    if (!equips.length) {
      setStatus("没有解析到有效的主装备数据。", "warn");
      return;
    }

    state.mainEquip = equips[0];
    state.baseMainEquip = cloneEquipment(state.mainEquip, "main");
    state.attrKeys = Object.keys(state.mainEquip.attrs);
    state.allEquips = state.allEquips.filter((equip) => equip.id !== state.mainEquip.id);
    state.allEquips.forEach((equip) => {
      equip.used = false;
    });
    resetProgress();
    refreshUI();
    saveState();

    if (equips.length > 1) {
      setStatus(`已设置主装备：${state.mainEquip}；其余行已忽略。`, "warn");
    } else {
      setStatus(`已设置主装备：${state.mainEquip}。`, "ok");
    }
  }

  function loadDonorEquips(equips) {
    if (!equips.length) {
      setStatus("没有解析到有效的融合装备数据。", "warn");
      return;
    }

    const inventoryById = new Map(
      state.allEquips
        .filter((equip) => equip.source === "inventory")
        .map((equip) => [equip.id, equip]),
    );
    for (const equip of equips) {
      if (equip.id === state.mainEquip?.id) continue;
      equip.source = "inventory";
      inventoryById.set(equip.id, equip);
    }
    const otherEquips = state.allEquips.filter((equip) => equip.source === "other");
    state.allEquips = [...inventoryById.values(), ...otherEquips];
    if (!state.attrKeys.length) state.attrKeys = Object.keys(equips[0].attrs);
    resetProgress();
    state.activeTab = "inventory";
    refreshUI();
    saveState();

    const inconsistent = state.allEquips.filter((equip) =>
      state.attrKeys.some((key) => !Object.prototype.hasOwnProperty.call(equip.attrs, key)),
    );
    if (inconsistent.length) {
      setStatus(`已载入 ${state.allEquips.length} 件融合装备；缺少属性会按 0 处理。`, "warn");
    } else {
      setStatus(`已载入 ${state.allEquips.length} 件融合装备。`, "ok");
    }
  }

  function getVisibleEquips() {
    if (state.activeTab === "inventory") {
      return state.allEquips.filter((equip) => equip.source === "inventory");
    }
    if (state.activeTab === "other") {
      return state.allEquips.filter((equip) => equip.source === "other");
    }
    if (state.activeTab === "used") {
      return state.allEquips.filter((equip) => equip.used);
    }
    return state.allEquips;
  }

  function updateTabs() {
    const inventoryCount = state.allEquips.filter((equip) => equip.source === "inventory").length;
    const otherCount = state.allEquips.filter((equip) => equip.source === "other").length;
    const usedCount = state.allEquips.filter((equip) => equip.used).length;
    tabAllCount.textContent = String(state.allEquips.length);
    tabInventoryCount.textContent = String(inventoryCount);
    tabOtherCount.textContent = String(otherCount);
    tabUsedCount.textContent = String(usedCount);
    tabButtons.forEach((button) => {
      button.classList.toggle("active", button.dataset.tab === state.activeTab);
      button.setAttribute("aria-selected", button.dataset.tab === state.activeTab ? "true" : "false");
    });
  }

  function clearInfo() {
    mainName.innerHTML = "<b>（未粘贴）</b>";
    mainAttrs.innerHTML = "";
    mainPreview.textContent = "";
    fuseName.innerHTML = "<b>（未选择融合装备）</b>";
    fuseAttrs.innerHTML = "";
  }

  function getPageEquipData(id) {
    const pageWindow = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
    const dyn = pageWindow.dynjs_equip || {};
    return dyn[id] || null;
  }

  function parseTipValue(raw) {
    if (typeof raw === "number" && Number.isFinite(raw)) return { text: String(raw) };
    const text = String(raw ?? "").trim();
    if (!text) return null;
    const match = text.match(/^[+-]?\d+(?:\.\d+)?/);
    if (!match) return null;
    return { text };
  }

  function showEquipTip(equip, event) {
    if (!equip) return;
    equipTip.replaceChildren();

    const data = getPageEquipData(equip.id);
    const title = document.createElement("div");
    title.className = "hv-ms-tip-name";
    title.textContent = data?.t ? `[${equip.id}] ${data.t}` : `[${equip.id}] ${equip.name}`;
    equipTip.appendChild(title);

    const attrsPart = document.createElement("div");
    attrsPart.className = "hv-ms-tip-attrs";

    const seen = new Set();

    // 本地导入的 base 属性（原始数值）始终显示
    const localKeys = state.attrKeys.length
      ? [...state.attrKeys, ...Object.keys(equip.attrs).filter((key) => !state.attrKeys.includes(key))]
      : Object.keys(equip.attrs);
    for (const key of localKeys) {
      const value = Number(equip.attrs[key] || 0);
      if (!Number.isFinite(value)) continue;
      const normalized = key.toLowerCase().replace(/\s+/g, " ");
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      const row = document.createElement("span");
      row.textContent = `${key}: ${value}`;
      attrsPart.appendChild(row);
    }

    // 页面数据补充未覆盖的属性（含非 base 属性），宽松解析数值
    const stats = data?.s || null;
    if (stats) {
      for (const key of Object.keys(stats)) {
        const item = stats[key];
        const label = item?.label || "";
        if (!label) continue;
        const parsed = parseTipValue(item?.value);
        if (!parsed) continue;
        const normalized = label.toLowerCase().replace(/\s+/g, " ");
        if (seen.has(normalized)) continue;
        seen.add(normalized);
        const row = document.createElement("span");
        row.textContent = `${label}: ${parsed.text}`;
        attrsPart.appendChild(row);
      }
    }

    if (attrsPart.children.length) equipTip.appendChild(attrsPart);
    equipTip.style.display = "block";
    moveEquipTip(event);
  }

  function moveEquipTip(event) {
    const margin = 14;
    const tipWidth = equipTip.offsetWidth || 200;
    const tipHeight = equipTip.offsetHeight || 80;
    let left = event.clientX + margin;
    let top = event.clientY + margin;
    if (left + tipWidth > window.innerWidth - 6) left = event.clientX - tipWidth - margin;
    if (top + tipHeight > window.innerHeight - 6) top = event.clientY - tipHeight - margin;
    equipTip.style.left = `${Math.max(2, left)}px`;
    equipTip.style.top = `${Math.max(2, top)}px`;
  }

  function hideEquipTip() {
    equipTip.style.display = "none";
    equipTip.replaceChildren();
  }

  function updateList() {
    updateTabs();
    list.innerHTML = "";

    hideEquipTip();

    for (const equip of getVisibleEquips()) {
      const item = document.createElement("li");
      item.dataset.id = String(equip.id);
      item.classList.toggle("used", equip.used);
      const sourceLabel = equip.source === "other" ? "其他" : "库存";
      const usedLabel = equip.used ? " [已使用]" : "";

      const previewLabel = state.mainEquip
        ? ` [本次 +${calcPreview(state.mainEquip.attrs, equip.attrs).total}]`
        : "";
      const label = document.createElement("span");
      label.className = "hv-ms-equip-label";
      const sourceSpan = document.createElement("span");
      sourceSpan.textContent = `[${sourceLabel}]${usedLabel} `;
      const idSpan = document.createElement("span");
      idSpan.className = "hv-ms-equip-id";
      idSpan.textContent = String(equip.id);
      idSpan.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const hasKey = new RegExp(`/equip/${equip.id}/[^/?#]+`, "i").test(equip.equipUrl || "");
        let url = hasKey ? equip.equipUrl : "";
        if (!hasKey) {
          const pageUrl = buildEquipUrlFromPage(equip.id);
          if (pageUrl) {
            equip.equipUrl = pageUrl;
            url = pageUrl;
            saveState();
          }
        }
        if (!url) {
          showToast(`未找到装备 ${equip.id} 的完整链接，请重新导入该装备。`, "warn");
          return;
        }
        const popupWidth = 450;
        const popupHeight = 520;
        const popupLeft = Math.max(0, Math.round((window.screen.availWidth - popupWidth) / 2));
        const popupTop = Math.max(0, Math.round((window.screen.availHeight - popupHeight) / 2));
        window.open(url, "_blank", `noopener,width=${popupWidth},height=${popupHeight},left=${popupLeft},top=${popupTop}`);
      });
      label.append(sourceSpan, idSpan, document.createTextNode(previewLabel));
      label.addEventListener("mouseenter", (event) => showEquipTip(equip, event));
      label.addEventListener("mousemove", moveEquipTip);
      label.addEventListener("mouseleave", hideEquipTip);
      item.appendChild(label);

      if (state.fuseEquip?.id === equip.id) item.classList.add("selected");
      item.addEventListener("click", () => selectFuse(equip));

      const removeButton = document.createElement("button");
      removeButton.type = "button";
      removeButton.className = "hv-ms-remove";
      removeButton.textContent = "×";
      removeButton.setAttribute("aria-label", `移除装备 ${equip.id}`);
      removeButton.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        removeEquipment(equip);
      });
      item.appendChild(removeButton);
      list.appendChild(item);
    }
  }

  function displayAttrs(container, equip, changes = null) {
    container.innerHTML = "";

    for (const key of state.attrKeys) {
      const value = Number(equip.attrs[key] || 0);
      const item = document.createElement("span");
      item.className = "hv-ms-attr";

      if (changes && changes[key]) {
        const [oldValue, gain] = changes[key];
        item.append(document.createTextNode(`${key}: ${oldValue} → ${oldValue + gain} `));
        const mark = document.createElement("em");
        mark.textContent = `(+${gain})`;
        item.appendChild(mark);
      } else {
        item.textContent = `${key}: ${value}`;
      }
      container.appendChild(item);
    }
  }

  function displayMain(equip, changes = null) {
    mainName.textContent = `[${equip.id}] ${equip.name}`;
    displayAttrs(mainAttrs, equip, changes);
    mainPreview.replaceChildren();

    const percent = qualityPercent(equip.attrs, equip.quality);
    const capLabel = equip.fuseCapLabel || "未知";
    const capName = FUSE_CAP[equip.fuseCap]?.label || "未知";
    const perFusion = fuseCostCredits(equip.attrs, equip.quality, equip.fuseCapCredits);
    const infoLine = document.createElement("div");
    infoLine.textContent = perFusion === null
      ? `优秀度：${percent.toFixed(1)}%｜费用上限：${capName}（${capLabel}）｜本次融合费用：未知`
      : `优秀度：${percent.toFixed(1)}%｜费用上限：${capName}（${capLabel}）｜本次融合费用：${formatCostCompact(perFusion)}`;
    mainPreview.appendChild(infoLine);

    if (!changes) return;

    const total = Object.values(changes).reduce((sum, item) => sum + item[1], 0);
    const gainLine = document.createElement("div");
    gainLine.textContent = `本次预计增加 ${total} 点属性`;
    mainPreview.appendChild(gainLine);

    const coreLine = document.createElement("div");
    coreLine.textContent = `本次消耗核心：${calcCoreCost(state.mainEquip, state.fuseEquip)}`;
    mainPreview.appendChild(coreLine);
  }

  function displayFuse(equip) {
    fuseName.textContent = `[${equip.id}] ${equip.name}`;
    displayAttrs(fuseAttrs, equip);
  }

  function refreshUI() {
    updateInventoryBar();
    updateList();
    clearInfo();

    if (state.mainEquip) displayMain(state.mainEquip);
    if (state.fuseEquip) displayFuse(state.fuseEquip);
  }

  function removeEquipment(equip) {
    if (state.busy) {
      showToast("搜索进行中，暂时不能移除装备。", "warn");
      return;
    }

    const index = state.allEquips.findIndex((item) => item.id === equip.id);
    if (index < 0) return;

    state.allEquips.splice(index, 1);
    if (state.fuseEquip?.id === equip.id) state.fuseEquip = null;
    state.savedInputId = "";
    refreshUI();
    updateInputSelector();
    saveState();
    showToast(`已移除装备 ${equip.id}。`);
  }

  async function exportCurrentPlan() {
    if (!state.currentPlan.length) {
      showToast("当前没有可导出的融合方案。", "warn");
      return;
    }

    const text = state.currentPlan
      .map((step, index) => `${index + 1}. ${step.id}`)
      .join("\n");

    try {
      await copyText(text);
      showToast("融合方案已复制到剪贴板。");
    } catch {
      prompt("复制失败，请手动复制融合顺序：", text);
    }
  }

  function selectFuse(equip) {
    if (equip.used) {
      showToast("该装备已使用，不能再次融合。", "warn");
      return;
    }
    if (state.mainEquip?.id === equip.id) {
      alert("主装备不能作为祭品。请点击其他装备。");
      return;
    }

    state.fuseEquip = equip;
    displayFuse(equip);
    updatePreview();
    saveState();
    list.querySelectorAll("li").forEach((item) => {
      item.classList.toggle("selected", Number(item.dataset.id) === equip.id);
    });
  }

  function updatePreview() {
    if (!state.mainEquip || !state.fuseEquip) {
      if (state.mainEquip) displayMain(state.mainEquip);
      return;
    }
    const result = calcPreview(state.mainEquip.attrs, state.fuseEquip.attrs);
    displayMain(state.mainEquip, result.changes);
  }

  function calcPreview(mainAttrsInput, fuseAttrsInput) {
    const newAttrs = { ...mainAttrsInput };
    const changes = {};
    const actualAdds = {};
    let overflowPoints = 0;
    let total = 0;

    for (const key of state.attrKeys) {
      const mainValue = Number(mainAttrsInput[key] || 0);
      const fuseValue = Number(fuseAttrsInput[key] || 0);
      const baseGain = fuseValue > mainValue ? 2 : 1;

      if (mainValue >= 200) {
        actualAdds[key] = 0;
        overflowPoints += baseGain;
      } else {
        actualAdds[key] = Math.min(baseGain, 200 - mainValue);
      }
      changes[key] = [mainValue, actualAdds[key]];
    }

    while (overflowPoints > 0) {
      const sortedKeys = state.attrKeys
        .map((key, index) => ({
          key,
          index,
          value: Number(mainAttrsInput[key] || 0) + actualAdds[key],
        }))
        .sort((a, b) => a.value - b.value || a.index - b.index);

      let assigned = 0;
      for (const item of sortedKeys) {
        if (overflowPoints <= 0) break;
        if (item.value < 200) {
          actualAdds[item.key] += 1;
          overflowPoints -= 1;
          assigned += 1;
        }
      }
      if (!assigned) break;
    }

    for (const key of state.attrKeys) {
      const oldValue = Number(mainAttrsInput[key] || 0);
      const gain = actualAdds[key];
      newAttrs[key] = oldValue + gain;
      changes[key] = [oldValue, gain];
      total += gain;
    }

    return { newAttrs, changes, total };
  }

  function isMaxed(attrs) {
    return state.attrKeys.length > 0 && state.attrKeys.every((key) => Number(attrs[key] || 0) >= 200);
  }

  function totalDeficit(attrs) {
    return state.attrKeys.reduce((sum, key) => sum + Math.max(0, 200 - Number(attrs[key] || 0)), 0);
  }

  function formatElapsed(milliseconds) {
    if (milliseconds < 1000) return `${Math.round(milliseconds)} 毫秒`;
    return `${(milliseconds / 1000).toFixed(2)} 秒`;
  }

  function greedyPlan(targetAttrs, donors) {
    let attrs = { ...targetAttrs };
    let usedMask = 0n;
    const path = [];

    while (!isMaxed(attrs)) {
      let best = null;

      for (let index = 0; index < donors.length; index += 1) {
        const bit = 1n << BigInt(index);
        if (usedMask & bit) continue;

        const result = calcPreview(attrs, donors[index].attrs);
        if (!best || result.total > best.result.total) {
          best = { index, bit, result };
        }
      }

      if (!best) break;
      usedMask |= best.bit;
      attrs = best.result.newAttrs;
      path.push(best.index);
    }

    return { path, attrs, complete: isMaxed(attrs) };
  }

  function optimisticCanReach(attrs, donors, usedMask, slots, donorBits = null) {
    const deficit = totalDeficit(attrs);
    if (deficit === 0) return true;
    if (slots <= 0) return false;

    const upperGains = [];
    for (let index = 0; index < donors.length; index += 1) {
      const bit = donorBits ? donorBits[index] : 1n << BigInt(index);
      if (usedMask & bit) continue;

      let upper = 0;
      for (const key of state.attrKeys) {
        const current = Number(attrs[key] || 0);
        const donor = Number(donors[index].attrs[key] || 0);
        // This is deliberately optimistic: it is an upper bound, not a prediction.
        upper += current >= 200 ? 2 : donor > current ? 2 : 1;
      }
      upperGains.push(upper);
    }

    upperGains.sort((a, b) => b - a);
    const usable = Math.min(slots, upperGains.length);
    let possible = 0;
    for (let index = 0; index < usable; index += 1) possible += upperGains[index];
    return possible >= deficit;
  }

  async function findMinimumPlanFast(targetAttrs, donors, timeLimitMs, report) {
    const started = performance.now();
    let nodes = 0;
    let timedOut = false;
    let paused = false;
    const greedy = greedyPlan(targetAttrs, donors);
    let best = greedy.complete ? { path: greedy.path, steps: greedy.path.length } : null;
    const donorBits = donors.map((_, index) => 1n << BigInt(index));

    const deficit = totalDeficit(targetAttrs);
    if (deficit === 0) {
      return { path: [], steps: 0, proven: true, timedOut: false, paused: false, nodes: 0 };
    }

    const lowerBound = Math.ceil(deficit / Math.max(1, 2 * state.attrKeys.length));
    const lastLimit = best ? best.steps - 1 : donors.length;

    if (lowerBound > donors.length) {
      return { path: null, steps: null, proven: true, timedOut: false, paused: false, nodes: 0 };
    }

    function checkpoint() {
      if (state.pauseRequested) {
        paused = true;
        return "stop";
      }

      nodes += 1;
      if (nodes % YIELD_EVERY_NODES !== 0) return "continue";

      if (performance.now() - started >= timeLimitMs) {
        timedOut = true;
        return "stop";
      }

      report(`精确搜索中：已检查 ${nodes.toLocaleString()} 个状态……`);
      return "yield";
    }

    function createFrame(attrs, usedMask, depth, pathLength) {
      return {
        attrs,
        usedMask,
        depth,
        pathLength,
        checkpointed: false,
        candidates: null,
        nextCandidate: 0,
      };
    }

    function popFrame(searchState) {
      const frame = searchState.stack.pop();
      searchState.path.length = frame.pathLength;
    }

    function runSearchBatch(searchState, limit) {
      const { stack, path, memo } = searchState;

      while (stack.length) {
        const frame = stack[stack.length - 1];

        if (!frame.checkpointed) {
          frame.checkpointed = true;
          const status = checkpoint();
          if (status === "stop") return { type: "stopped" };
          if (status === "yield") return { type: "yield" };
        }

        if (!frame.candidates) {
          if (isMaxed(frame.attrs)) return { type: "found", path: path.slice() };
          if (frame.depth >= limit) {
            popFrame(searchState);
            continue;
          }

          const key = `${frame.usedMask.toString(16)}|${state.attrKeys.map((name) => Number(frame.attrs[name] || 0)).join(",")}`;
          if (memo.has(key)) {
            popFrame(searchState);
            continue;
          }
          memo.add(key);

          const slots = limit - frame.depth;
          if (!optimisticCanReach(frame.attrs, donors, frame.usedMask, slots, donorBits)) {
            popFrame(searchState);
            continue;
          }

          const candidates = [];
          for (let index = 0; index < donors.length; index += 1) {
            const bit = donorBits[index];
            if (frame.usedMask & bit) continue;

            const result = calcPreview(frame.attrs, donors[index].attrs);
            candidates.push({ index, bit, result });
          }

          candidates.sort((a, b) => b.result.total - a.result.total || a.index - b.index);
          frame.candidates = candidates;
        }

        if (frame.nextCandidate >= frame.candidates.length) {
          popFrame(searchState);
          continue;
        }

        const candidate = frame.candidates[frame.nextCandidate];
        frame.nextCandidate += 1;
        path.push(candidate.index);
        stack.push(
          createFrame(
            candidate.result.newAttrs,
            frame.usedMask | candidate.bit,
            frame.depth + 1,
            path.length - 1,
          ),
        );
      }

      return { type: "done" };
    }

    for (let limit = lowerBound; limit <= lastLimit; limit += 1) {
      report(`正在验证是否可以在 ${limit} 次融合内满级……`);
      const searchState = {
        stack: [createFrame({ ...targetAttrs }, 0n, 0, 0)],
        path: [],
        memo: new Set(),
      };

      let result;
      do {
        result = runSearchBatch(searchState, limit);
        if (result.type !== "yield") break;

        await new Promise((resolve) => setTimeout(resolve, 0));
        if (state.pauseRequested) {
          paused = true;
          break;
        }
        if (performance.now() - started >= timeLimitMs) {
          timedOut = true;
          break;
        }
      } while (true);

      if (result.type === "found") {
        return { path: result.path, steps: result.path.length, proven: true, timedOut: false, paused: false, nodes };
      }
      if (timedOut || paused) break;
    }

    if (best) {
      return { path: best.path, steps: best.steps, proven: !timedOut && !paused, timedOut, paused, nodes };
    }

    return { path: null, steps: null, proven: !timedOut && !paused, timedOut, paused, nodes };
  }

  function applyFusion(donor, writeLog = true) {
    const result = calcPreview(state.mainEquip.attrs, donor.attrs);
    const cost = fuseCostCredits(state.mainEquip.attrs, state.mainEquip.quality, state.mainEquip.fuseCapCredits);
    const percent = qualityPercent(state.mainEquip.attrs, state.mainEquip.quality);
    const cores = calcCoreCost(state.mainEquip, donor);
    state.mainEquip.attrs = result.newAttrs;
    if (cost !== null) state.totalFusionCost += cost;
    state.totalCores += cores;

    const storedDonor = state.allEquips.find((equip) => equip.id === donor.id);
    if (storedDonor) storedDonor.used = true;
    state.fusionCount += 1;

    if (writeLog) {
      const newPercent = qualityPercent(state.mainEquip.attrs, state.mainEquip.quality);
      state.conciseLog.push(
        `${state.conciseLog.length + 1} [${donor.id}] 本次费用: ${cost === null ? "未知" : formatCostCompact(cost)} 本次增加 ${result.total} 点属性 本次核心：${cores} （${percent.toFixed(1)}%→${newPercent.toFixed(1)}%）`,
      );
      log(`祭品 [${donor.id}] → 主装备 [${state.mainEquip.id}]`);
      log(cost === null
        ? `本次费用：未知（${percent.toFixed(1)}%→${newPercent.toFixed(1)}%）`
        : `本次费用：${formatCost(cost)}（${percent.toFixed(1)}%→${newPercent.toFixed(1)}%）`);
      log(`本次增加 ${result.total} 点属性`);
      log(`本次核心：${cores}`);
      for (const key of state.attrKeys) {
        const [oldValue, gain] = result.changes[key];
        log(`  ${key}: ${oldValue} → ${oldValue + gain} (+${gain})`);
      }
      log("----------------------------------------");
    }

    saveState();

    return result;
  }

  async function findBeamPlan(targetAttrs, donors, report) {
    const BEAM_WIDTH = 150;
    const CANDIDATE_WIDTH = 20;
    let nodes = 0;

    const rank = (left, right) => {
      const leftMaxed = isMaxed(left.attrs);
      const rightMaxed = isMaxed(right.attrs);
      if (leftMaxed !== rightMaxed) return leftMaxed ? -1 : 1;

      const deficitDifference = totalDeficit(left.attrs) - totalDeficit(right.attrs);
      if (deficitDifference !== 0) return deficitDifference;
      if (left.score !== right.score) return right.score - left.score;
      return left.path.length - right.path.length;
    };

    let beam = [{
      attrs: { ...targetAttrs },
      usedMask: 0n,
      score: 0,
      path: [],
    }];

    for (let depth = 0; depth <= donors.length; depth += 1) {
      report(`束搜索中：筛选第 ${depth} 次融合顺序……`);

      const complete = beam.find((item) => isMaxed(item.attrs));
      if (complete) {
        return {
          path: complete.path,
          steps: complete.path.length,
          complete: true,
          nodes,
        };
      }
      if (depth >= donors.length) break;

      const next = [];
      for (const item of beam) {
        nodes += 1;
        const candidates = [];

        for (let index = 0; index < donors.length; index += 1) {
          const bit = 1n << BigInt(index);
          if (item.usedMask & bit) continue;

          const result = calcPreview(item.attrs, donors[index].attrs);
          candidates.push({ index, bit, result });
        }

        candidates.sort((left, right) => (
          right.result.total - left.result.total || left.index - right.index
        ));

        for (const candidate of candidates.slice(0, CANDIDATE_WIDTH)) {
          next.push({
            attrs: candidate.result.newAttrs,
            usedMask: item.usedMask | candidate.bit,
            score: item.score + candidate.result.total,
            path: [...item.path, candidate.index],
          });
        }
      }

      if (!next.length) break;

      const deduped = new Map();
      for (const item of next) {
        const key = `${item.usedMask.toString(16)}|${state.attrKeys.map((name) => Number(item.attrs[name] || 0)).join(",")}`;
        const previous = deduped.get(key);
        if (!previous || rank(item, previous) < 0) deduped.set(key, item);
      }

      beam = [...deduped.values()].sort(rank).slice(0, BEAM_WIDTH);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    return { path: null, steps: null, complete: false, nodes };
  }

  async function doBeamFusion() {
    if (state.busy) return;
    if (!state.mainEquip) {
      alert("请先粘贴主装备数据。");
      return;
    }

    restoreCalculationState();
    saveState();
    const donors = state.allEquips.filter((equip) => !equip.used);
    if (!donors.length) {
      setStatus("没有可用的献祭装备。", "warn");
      return;
    }

    const startedAt = performance.now();
    state.busy = true;
    state.pauseRequested = false;
    beamButton.disabled = true;
    autoButton.disabled = true;
    pauseButton.disabled = true;
    setCurrentPlan([]);
    saveState();
    setStatus("正在使用束搜索计算融合顺序……");

    const result = await findBeamPlan(
      { ...state.mainEquip.attrs },
      donors,
      (message) => setStatus(message),
    );
    const elapsedText = formatElapsed(performance.now() - startedAt);

    state.busy = false;
    state.pauseRequested = false;
    beamButton.disabled = false;
    autoButton.disabled = false;

    if (!result.complete || !result.path) {
      const message = "束搜索没有找到可执行的完整方案。";
      setStatus(`${message} 用时 ${elapsedText}，检查 ${result.nodes.toLocaleString()} 个状态。`, "warn");
      alert(`${message}\n本次用时：${elapsedText}`);
      return;
    }

    setCurrentPlan(
      result.path.map((donorIndex) => donors[donorIndex]).filter(Boolean),
      {
        steps: result.steps,
        proven: false,
        timedOut: false,
        elapsed: elapsedText,
        nodes: result.nodes,
        kind: "beam",
      },
    );
    saveState();

    for (const donorIndex of result.path) {
      const donor = donors[donorIndex];
      if (donor && state.allEquips.some((equip) => equip.id === donor.id && !equip.used)) {
        applyFusion(donor);
      }
    }

    state.fuseEquip = null;
    updateCount();
    refreshUI();
    saveState();
    setStatus(
      `计算： ${result.steps} 次融合，用时 ${elapsedText}，检查 ${result.nodes.toLocaleString()} 个状态，未证明最优`,
      "ok",
    );
    alert(
      `束搜索顺序已执行\n融合次数：${result.steps}\n检查状态数：${result.nodes.toLocaleString()}\n总费用：${formatCost(state.totalFusionCost)}\n本次用时：${elapsedText}`,
    );
  }

  function doManualFusion() {
    if (!state.mainEquip) {
      alert("请先粘贴主装备数据。");
      return;
    }
    if (!state.fuseEquip) {
      alert("请先点击左侧列表选择祭品。");
      return;
    }

    const donor = state.fuseEquip;
    setCurrentPlan(
      [donor],
      { steps: 1, proven: false, timedOut: false, elapsed: "", nodes: 0, kind: "manual" },
    );
    const manualCost = fuseCostCredits(state.mainEquip.attrs, state.mainEquip.quality, state.mainEquip.fuseCapCredits);
    const manualCores = calcCoreCost(state.mainEquip, donor);
    applyFusion(donor);
    state.fuseEquip = null;
    updateCount();
    refreshUI();
    saveState();
    setStatus(manualCost === null ? `手动融合完成，本次费用未知，本次核心 ${manualCores}。` : `手动融合完成，本次费用 ${formatCost(manualCost)}，本次核心 ${manualCores}。`, "ok");
    alert(manualCost === null
      ? `融合完成。\n本次费用：未知\n本次核心：${manualCores}\n累计费用：${formatCost(state.totalFusionCost)}\n累计核心：${state.totalCores}`
      : `融合完成。\n本次费用：${formatCost(manualCost)}\n本次核心：${manualCores}\n累计费用：${formatCost(state.totalFusionCost)}\n累计核心：${state.totalCores}`);
  }

  async function doMinimumFusion() {
    if (state.busy) return;
    if (!state.mainEquip) {
      alert("请先粘贴主装备数据。");
      return;
    }

    restoreCalculationState();
    saveState();
    const seconds = Math.min(
      300,
      Math.max(1, Number.parseInt($("hv-minsteps-time").value, 10) || SEARCH_DEFAULT_SECONDS),
    );
    const donors = state.allEquips.filter((equip) => !equip.used);
    const startedAt = performance.now();
    state.busy = true;
    state.pauseRequested = false;
    autoButton.disabled = true;
    beamButton.disabled = true;
    pauseButton.disabled = false;
    setCurrentPlan([]);
    saveState();
    setStatus(`正在寻找最少融合次数方案，时间上限 ${seconds} 秒……`);

    const result = await findMinimumPlanFast(
      { ...state.mainEquip.attrs },
      donors,
      seconds * 1000,
      (message) => setStatus(message),
    );
    const elapsedText = formatElapsed(performance.now() - startedAt);

    state.busy = false;
    autoButton.disabled = false;
    beamButton.disabled = false;
    pauseButton.disabled = true;
    state.pauseRequested = false;

    if (!result.path) {
      if (result.paused) {
        const message = "搜索已暂停，当前没有可执行的完整方案。";
        setStatus(`${message} 用时 ${elapsedText}，检查 ${result.nodes.toLocaleString()} 个状态。`, "warn");
        alert(`${message}\n本次用时：${elapsedText}`);
        return;
      }

      const message = result.timedOut
        ? "搜索超时，暂时没有可执行的完整方案。"
        : "使用当前祭品无法达到全属性 200。";
      setStatus(`${message} 用时 ${elapsedText}，检查 ${result.nodes.toLocaleString()} 个状态。`, "warn");
      alert(`${message}\n本次用时：${elapsedText}`);
      return;
    }

    const path = result.path;
    setCurrentPlan(
      path.map((donorIndex) => donors[donorIndex]).filter(Boolean),
      {
        steps: result.steps,
        proven: result.proven,
        timedOut: result.timedOut,
        elapsed: elapsedText,
        nodes: result.nodes,
        kind: "auto",
      },
    );
    saveState();
    for (const donorIndex of path) {
      const donor = donors[donorIndex];
      if (donor && state.allEquips.some((equip) => equip.id === donor.id && !equip.used)) {
        applyFusion(donor);
      }
    }

    state.fuseEquip = null;
    updateCount();
    refreshUI();
    saveState();

    if (result.paused) {
      setStatus(
        `已暂停，当前方案：${result.steps} 次融合，用时 ${elapsedText}，检查 ${result.nodes.toLocaleString()} 个状态，总费用 ${formatCostCompact(state.totalFusionCost)}，尚未证明最优`,
        "warn",
      );
      alert(
        `已暂停，已执行当前方案\n融合次数：${result.steps}\n检查状态数：${result.nodes.toLocaleString()}\n总费用：${formatCost(state.totalFusionCost)}\n注意：尚未证明这是最少次数。\n本次用时：${elapsedText}`,
      );
    } else if (result.proven) {
      setStatus(
        `已证明最优：${result.steps} 次融合，用时 ${elapsedText}，检查 ${result.nodes.toLocaleString()} 个状态，总费用 ${formatCostCompact(state.totalFusionCost)}`,
        "ok",
      );
      alert(
        `已证明最优方案\n融合次数：${result.steps}\n检查状态数：${result.nodes.toLocaleString()}\n总费用：${formatCost(state.totalFusionCost)}\n本次用时：${elapsedText}`,
      );
    } else {
      setStatus(
        `当前方案：${result.steps} 次融合，用时 ${elapsedText}，检查 ${result.nodes.toLocaleString()} 个状态，总费用 ${formatCostCompact(state.totalFusionCost)}，尚未证明最优`,
        "warn",
      );
      alert(
        `当前方案已执行\n融合次数：${result.steps}\n总费用：${formatCost(state.totalFusionCost)}\n注意：尚未证明这是最少次数。\n本次用时：${elapsedText}`,
      );
    }
  }

  function restoreCalculationState() {
    state.pauseRequested = false;
    state.mainEquip = cloneEquipment(state.baseMainEquip, "main") || state.mainEquip;
    state.allEquips.forEach((equip) => {
      equip.used = false;
    });
    state.fuseEquip = null;
    state.fusionCount = 0;
    state.totalFusionCost = 0;
    state.totalCores = 0;
    state.currentPlan = [];
    state.currentPlanMeta = null;
    state.activeTab = "all";
    clearLog();
    updateCount();
    refreshUI();
    updateInputSelector();
  }

  function resetCalculation() {
    if (state.busy) {
      showToast("搜索进行中，暂时不能重置计算。", "warn");
      return;
    }

    restoreCalculationState();
    saveState();
    setStatus("计算已重置，装备数据已保留。", "ok");
    showToast("计算已重置。");
  }

  function resetData() {
    state.pauseRequested = false;
    state.allEquips = [];
    state.mainEquip = null;
    state.baseMainEquip = null;
    state.fuseEquip = null;
    state.attrKeys = [];
    state.fusionCount = 0;
    state.totalFusionCost = 0;
    state.totalCores = 0;
    state.activeTab = "all";
    state.currentPlan = [];
    state.currentPlanMeta = null;
    state.savedInputId = "";
    try {
      getPageStorage()?.removeItem(STORAGE_KEY);
    } catch {
      // Storage may be disabled; the in-memory reset still succeeds.
    }
    updateCount();
    clearLog();
    refreshUI();
    updateInputSelector();
    setStatus("数据已重置。", "ok");
  }

  function isFusionPage() {
    const params = new URLSearchParams(location.search);
    return params.get("s") === "Bazaar"
      && params.get("ss") === "am"
      && params.get("screen") === "statfuse";
  }

  function setupFusionPagePlanTools() {
    if (!isFusionPage() || document.getElementById("hv-minsteps-page-import-plan")) return;

    const pageStyle = document.createElement("style");
    pageStyle.id = "hv-minsteps-fusion-plan-style";
    pageStyle.textContent = `
      .hv-minsteps-page-order-cell {
        width: 28px;
        min-width: 28px;
        color: #5c0d11;
        font-weight: bold;
        text-align: right;
        white-space: nowrap;
      }
      #hv-minsteps-actions #hv-minsteps-page-import-main {
        margin-top: 12px;
      }
      #hv-minsteps-actions #hv-minsteps-page-import-plan {
        margin-top: 12px;
      }
    `;
    document.head.appendChild(pageStyle);

    const importButton = document.createElement("button");
    importButton.id = "hv-minsteps-page-import-plan";
    importButton.type = "button";
    importButton.className = "hvut-side-mid";
    importButton.textContent = "导入方案";
    const clearButton = document.createElement("button");
    clearButton.id = "hv-minsteps-page-clear-plan";
    clearButton.type = "button";
    clearButton.className = "hvut-side-bottom";
    clearButton.textContent = "清除方案";
    const importMaterialsButton = document.createElement("button");
    importMaterialsButton.id = "hv-minsteps-page-import-materials";
    importMaterialsButton.type = "button";
    importMaterialsButton.className = "hvut-side-mid";
    importMaterialsButton.textContent = "导入素材";
    const importMainButton = document.createElement("button");
    importMainButton.id = "hv-minsteps-page-import-main";
    importMainButton.type = "button";
    importMainButton.className = "hvut-side-mid";
    importMainButton.textContent = "导入主装备";

    const armoryActions = document.getElementById("hv-minsteps-actions");
    if (armoryActions) {
      armoryActions.append(importMainButton, importMaterialsButton, importButton, clearButton);
      setActionPanelPosition(armoryActions, {
        left: Number.parseFloat(armoryActions.style.left),
        top: Number.parseFloat(armoryActions.style.top),
      }, true);
    }

    const pageState = { originalRuns: null };

    function getEquipmentRows() {
      return [...document.querySelectorAll("#equiplist tr[data-eid]")]
        .filter((row) => row.querySelector('input[name="eqids[]"]'));
    }

    function getEquipmentRuns(rows) {
      const rowsByParent = new Map();
      for (const row of rows) {
        if (!row.parentElement) continue;
        if (!rowsByParent.has(row.parentElement)) rowsByParent.set(row.parentElement, new Set());
        rowsByParent.get(row.parentElement).add(row);
      }

      const runs = [];
      for (const [parent, rowSet] of rowsByParent) {
        let current = [];
        const flush = () => {
          if (current.length) runs.push({ rows: current, parent });
          current = [];
        };

        for (const child of [...parent.children]) {
          if (rowSet.has(child)) current.push(child);
          else flush();
        }
        flush();
      }
      return runs;
    }

    function replaceEquipmentRun(runInfo, orderedRows, anchorOverride) {
      const parent = runInfo.parent || runInfo.rows[0]?.parentElement;
      if (!parent || !runInfo.rows.length) return;

      const anchor = anchorOverride === undefined
        ? runInfo.rows[runInfo.rows.length - 1].nextSibling
        : anchorOverride;
      for (const row of runInfo.rows) {
        if (row.parentNode === parent) parent.removeChild(row);
      }

      const fragment = document.createDocumentFragment();
      orderedRows.forEach((row) => fragment.appendChild(row));
      if (anchor?.parentNode === parent) parent.insertBefore(fragment, anchor);
      else parent.appendChild(fragment);
    }

    function captureOriginalOrder(rows) {
      pageState.originalRuns = getEquipmentRuns(rows).map((runInfo) => ({
        rows: [...runInfo.rows],
        parent: runInfo.parent,
        anchor: runInfo.rows[runInfo.rows.length - 1].nextSibling,
      }));
    }

    function restoreOriginalOrder() {
      if (!pageState.originalRuns) return;
      for (const runInfo of pageState.originalRuns) {
        replaceEquipmentRun(runInfo, runInfo.rows, runInfo.anchor);
      }
    }

    function clearPageOrderMarkers() {
      document.querySelectorAll(".hv-minsteps-page-order-cell, .hv-minsteps-page-order")
        .forEach((node) => node.remove());
    }

    function parsePlanIds(text) {
      const ids = [];
      const seen = new Set();
      for (const rawLine of text.split(/\r?\n/)) {
        const numbers = rawLine.match(/\d{6,}/g);
        if (!numbers?.length) continue;

        const id = numbers[numbers.length - 1];
        if (seen.has(id)) continue;
        seen.add(id);
        ids.push(id);
      }
      return ids;
    }

    function applyPagePlan(ids) {
      let rows = getEquipmentRows();
      if (!rows.length) {
        alert("没有找到可选的融合装备。");
        return;
      }

      if (pageState.originalRuns) restoreOriginalOrder();
      else captureOriginalOrder(rows);
      rows = getEquipmentRows();
      clearPageOrderMarkers();

      const rowById = new Map(rows.map((row) => [String(row.dataset.eid), row]));
      const orderById = new Map(ids.map((id, index) => [id, index]));
      const originalIndex = new Map(rows.map((row, index) => [row, index]));
      const foundIds = [];
      const missingIds = [];

      ids.forEach((id, index) => {
        const row = rowById.get(id);
        if (!row) {
          missingIds.push({ index: index + 1, id });
          return;
        }

        foundIds.push(id);
      });

      if (!foundIds.length) {
        alert("方案中的装备均不在当前可选列表中。");
        return;
      }

      const markerCellByRow = new Map();
      rows.forEach((row) => {
        const levelCell = row.querySelector(".hvut-eqp-level") || row.cells?.[1];
        if (levelCell) {
          const markerCell = document.createElement("td");
          markerCell.className = "hv-minsteps-page-order-cell";
          levelCell.parentNode.insertBefore(markerCell, levelCell);
          markerCellByRow.set(row, markerCell);
        }
      });

      ids.forEach((id, index) => {
        const markerCell = markerCellByRow.get(rowById.get(id));
        if (markerCell) markerCell.textContent = `${index + 1}.`;
      });

      for (const runInfo of getEquipmentRuns(rows)) {
        const orderedRows = [...runInfo.rows].sort((left, right) => {
          const leftOrder = orderById.has(String(left.dataset.eid))
            ? orderById.get(String(left.dataset.eid))
            : Number.POSITIVE_INFINITY;
          const rightOrder = orderById.has(String(right.dataset.eid))
            ? orderById.get(String(right.dataset.eid))
            : Number.POSITIVE_INFINITY;
          return leftOrder - rightOrder
            || originalIndex.get(left) - originalIndex.get(right);
        });
        replaceEquipmentRun(runInfo, orderedRows);
      }

      if (missingIds.length) {
        const missingText = missingIds
          .map(({ index, id }) => `${index}. ${id}`)
          .join("\n");
        alert(`方案已导入，但有 ${missingIds.length} 件装备不在当前列表中：\n${missingText}`);
      }
    }

    importButton.addEventListener("click", () => {
      const text = prompt(
        "请粘贴融合顺序，每行格式：1. 装备ID",
        "",
      );
      if (text === null) return;

      const ids = parsePlanIds(text);
      if (!ids.length) {
        alert("没有识别到有效的装备ID。");
        return;
      }
      applyPagePlan(ids);
    });

    clearButton.addEventListener("click", () => {
      clearPageOrderMarkers();
      restoreOriginalOrder();
    });

    const CHINESE_ATTR_MAP = {
      "攻击准确率": "Attack Accuracy", "魔法命中值": "Magic Accuracy",
      "物理缓解": "Physical Mitigation", "魔法缓解": "Magical Mitigation",
      "闪避": "Evade", "抗性": "Resist",
      "物理伤害": "Physical Damage", "魔法伤害": "Magic Damage",
      "魔法暴击伤害": "Magic Crit Damage", "攻击伤害": "Attack Damage",
      "攻击暴击伤害": "Attack Crit Damage", "打击伤害": "Physical Damage",
      "反抵抗": "Counter-Resist", "招架": "Parry",
      "火焰": "Fire", "冰冻": "Cold", "闪电": "Elec", "疾风": "Wind",
      "神圣": "Holy", "黑暗": "Dark",
      "元素魔法": "Elemental", "黑暗魔法": "Dark", "减益魔法": "Deprecating", "支援魔法": "Supportive",
      "智力": "Intelligence", "智慧": "Wisdom", "敏捷": "Agility",
      "力量": "Strength", "灵巧": "Dexterity", "体质": "Endurance",
    };

    function normalizeAttrName(name) {
      const cleaned = cleanName(name.replace(/\s+/g, " "));
      return CHINESE_ATTR_MAP[cleaned] || normalizeAttributeName(cleaned);
    }

    function eqtTypeFromFilter(filter) {
      const map = {
        armor_cloth: "Cloth Armor", armor_light: "Light Armor", armor_heavy: "Heavy Armor",
        weapon_staff: "Staff", weapon_onehand: "One-Handed", weapon_twohand: "Two-Handed",
        shield: "Shield",
      };
      return map[filter] || "";
    }

    function parseMainEquipFromModify(html, id, eqtType) {
      const doc = new DOMParser().parseFromString(html, "text/html");
      const root = doc.querySelector(".showequip") || doc;
      let name = "";
      const firstDiv = root.querySelector(".showequip > div:first-child, #popup_box > div:first-child");
      if (firstDiv) name = String(firstDiv.textContent || "").replace(/\s+/g, " ").trim();
      if (!name) name = String(id);
      const attrs = {};
      root.querySelectorAll('[title*="Base"], [title*="基础值"]').forEach((node) => {
        const title = node.getAttribute("title") || "";
        const match = title.match(/(?:Base|基础值)[:：]\s*(\d+)/);
        if (!match) return;
        const rawName = node.firstElementChild?.textContent?.trim() || node.querySelector("span")?.textContent?.trim();
        if (!rawName) return;
        const attrName = normalizeAttrName(rawName);
        if (attrName) attrs[attrName] = Number.parseInt(match[1], 10);
      });
      if (!Object.keys(attrs).length) throw new Error("modify 页面没有识别到带基础值的装备属性");
      return new Equipment(Number(id), name, attrs, "main", eqtType || "", "");
    }

    async function getPageMainEquip() {
      let mainId = new URLSearchParams(location.search).get("upgrade_eqid");
      if (!mainId) {
        const itemLink = document.querySelector('#itemlist a[href*="eqids[]"]');
        const match = (itemLink?.href || "").match(/eqids\[\]=(\d+)/);
        if (match) mainId = match[1];
      }
      if (!mainId) return null;
      mainId = String(mainId);

      // 1) 页面动态 JS（dynjs_equip）里通常直接带有主装备的校验码与完整属性
      const pageData = (typeof window !== "undefined" && (window.dynjs_equip || window.dynjs_eqstore))
        || (typeof unsafeWindow !== "undefined" && (unsafeWindow.dynjs_equip || unsafeWindow.dynjs_eqstore))
        || {};
      const data = pageData[mainId];
      if (data) {
        if (data.d) {
          try {
            const wrapped = `<div class="showequip"><div>${data.t || mainId}</div>${data.d}</div>`;
            return parseEquipmentPage(wrapped, Number(mainId), data.k ? `https://hentaiverse.org/equip/${mainId}/${data.k}` : "");
          } catch {}
        }
        if (data.k) {
          try {
            const url = `https://hentaiverse.org/equip/${mainId}/${data.k}`;
            const html = await requestEquipmentHtml(url);
            return parseEquipmentPage(html, Number(mainId), url);
          } catch {}
        }
      }

      // 2) 兜底：读取 modify 页面，从 showequip 直接解析主装备
      try {
        const itemLink = document.querySelector('#itemlist a[href*="eqids[]"]') || document.querySelector('#eqback a[href*="eqids[]"]');
        const href = itemLink?.href || "";
        const filter = href ? new URL(href, location.href).searchParams.get("filter") || "" : "";
        const eqtType = eqtTypeFromFilter(filter);
        const html = await requestEquipmentHtml(`https://hentaiverse.org/?s=Bazaar&ss=am&screen=modify&filter=${encodeURIComponent(filter)}&eqids[]=${mainId}`);
        return parseMainEquipFromModify(html, Number(mainId), eqtType);
      } catch {}
      return null;
    }

    importMainButton.addEventListener("click", async () => {
      if (state.busy) {
        showToast("正在读取装备，请稍候。", "warn");
        return;
      }
      const mainEquip = await getPageMainEquip();
      if (!mainEquip) {
        alert("没有找到主装备数据。");
        return;
      }
      setStatus("已读取主装备。");
      loadMainEquip([mainEquip]);
      showToast("已导入主装备。", "ok");
    });

    importMaterialsButton.addEventListener("click", async () => {
      if (state.busy) {
        showToast("正在读取装备，请稍候。", "warn");
        return;
      }
      const rows = getEquipmentRows();
      const links = [...new Set(
        rows
          .map((row) => {
            const id = row.getAttribute("data-eid");
            const key = row.getAttribute("data-key");
            return id ? `https://hentaiverse.org/equip/${id}${key ? `/${key}` : ""}` : "";
          })
          .filter(Boolean),
      )];
      if (!links.length) {
        alert("没有找到可选的融合素材。");
        return;
      }
      setStatus(`正在读取 ${links.length} 件融合素材……`);
      await loadInventoryInput(links.join("\n"));
      showToast(`已导入 ${links.length} 件融合素材。`, "ok");
    });
  }

  launchButton.addEventListener("click", () => panel.classList.toggle("open"));
  $("hv-minsteps-close").addEventListener("click", () => panel.classList.remove("open"));
  $("hv-minsteps-paste-main").addEventListener("click", async () => {
    const text = prompt("请输入主装备链接（支持 [url=装备链接]装备名称[/url] 格式）：", "");
    if (text !== null) await loadMainInput(text);
  });
  $("hv-minsteps-paste-donors").addEventListener("click", async () => {
    const text = prompt("请输入库存装备链接（每行一件，支持 [url=装备链接]装备名称[/url] 格式）：", "");
    if (text !== null) await loadInventoryInput(text);
  });
  $("hv-minsteps-add-other").addEventListener("click", async () => {
    const text = prompt("请输入其他装备链接（每行一件，支持 [url=装备链接]装备名称[/url] 格式）：", "");
    if (text !== null) await loadOtherInput(text);
  });
  function syncCoreControls() {
    const marketInput = document.getElementById("hv-minsteps-core-market");
    const inventoryInput = document.getElementById("hv-minsteps-core-inventory");
    const sourceSelect = document.getElementById("hv-minsteps-core-price-source");
    if (marketInput) marketInput.checked = state.coreMarketPrice;
    if (inventoryInput) inventoryInput.checked = state.useCoreInventory;
    if (sourceSelect) sourceSelect.value = state.corePriceSource;
  }
  (() => {
    const marketInput = document.getElementById("hv-minsteps-core-market");
    const inventoryInput = document.getElementById("hv-minsteps-core-inventory");
    const sourceSelect = document.getElementById("hv-minsteps-core-price-source");
    if (marketInput) marketInput.addEventListener("change", () => {
      state.coreMarketPrice = marketInput.checked;
      saveState();
      updateCount();
    });
    if (inventoryInput) inventoryInput.addEventListener("change", () => {
      state.useCoreInventory = inventoryInput.checked;
      saveState();
      updateCount();
    });
    if (sourceSelect) sourceSelect.addEventListener("change", () => {
      state.corePriceSource = sourceSelect.value;
      saveState();
    });
  })();

  $("hv-minsteps-reset-calculation").addEventListener("click", resetCalculation);
  $("hv-minsteps-reset").addEventListener("click", resetData);
  $("hv-minsteps-refresh-price").addEventListener("click", refreshPrice);
  $("hv-minsteps-refresh-inventory").addEventListener("click", refreshInventory);
  savePlanButton.addEventListener("click", saveInputData);
  deletePlanButton.addEventListener("click", deleteSavedInputData);
  planSelector.addEventListener("change", loadSavedInputData);
  tabButtons.forEach((button) => {
    button.addEventListener("click", () => {
      state.activeTab = button.dataset.tab || "all";
      updateList();
      saveState();
    });
  });
  list.addEventListener("scroll", hideEquipTip);
  $("hv-minsteps-do").addEventListener("click", doManualFusion);
  beamButton.addEventListener("click", doBeamFusion);
  autoButton.addEventListener("click", doMinimumFusion);
  pauseButton.addEventListener("click", () => {
    if (!state.busy) return;

    state.pauseRequested = true;
    pauseButton.disabled = true;
    setStatus("正在暂停搜索并整理当前方案…");
  });
  exportPlanButton.addEventListener("click", exportCurrentPlan);

  applySavedActionPanelPosition(actionPanel);
  makeDraggable(panel, panel.querySelector(".hv-ms-header"));
  makeDraggable(actionPanel, actionPanel, saveActionPanelPosition);
  window.addEventListener("resize", () => {
    setActionPanelPosition(actionPanel, {
      left: Number.parseFloat(actionPanel.style.left),
      top: Number.parseFloat(actionPanel.style.top),
    }, true);
  });
  updateInputSelector();
  syncCoreControls();
  restoreState();
  syncCoreControls();
  backfillEquipmentUrls();
  window.setTimeout(backfillEquipmentUrls, 1200);
  setupFusionPagePlanTools();
})();
