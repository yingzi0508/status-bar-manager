type StatusBarBinding = {
  id: string;
  label: string;
  worldbook_name: string;
  worldbook_entry_uid: number;
  worldbook_entry_name: string;
  regex_id: string;
  regex_script_name: string;
};

type StatusBarScriptSettings = {
  bindings: StatusBarBinding[];
};

const SCRIPT_BUTTON_NAME = '状态栏管理';
const EXT_ENTRY_ID = 'th-status-bar-extension-entry';
const SETTINGS_KEY = 'status_bar_manager_script';
const REGEX_PREFIX = '[状态栏] ';

function removeScriptLibraryButtons(): void {
  replaceScriptButtons([]);
}

function getSettingsRoot(): Record<string, any> {
  if (!SillyTavern.extensionSettings[SETTINGS_KEY]) {
    SillyTavern.extensionSettings[SETTINGS_KEY] = { bindings: [] };
  }
  return SillyTavern.extensionSettings[SETTINGS_KEY];
}

function loadSettings(): StatusBarScriptSettings {
  const root = getSettingsRoot();
  if (!Array.isArray(root.bindings)) {
    root.bindings = [];
  }
  return { bindings: root.bindings };
}

async function saveSettings(settings: StatusBarScriptSettings): Promise<void> {
  getSettingsRoot().bindings = settings.bindings;
  await SillyTavern.saveSettingsDebounced();
}

function ensureRegexPrefix(scriptName: string): string {
  if (scriptName.startsWith(REGEX_PREFIX)) {
    return scriptName;
  }
  return `${REGEX_PREFIX}${scriptName}`;
}

function parseImportedRegexList(payload: any): Partial<TavernRegex>[] {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (Array.isArray(payload?.regex_scripts)) {
    return payload.regex_scripts;
  }
  if (Array.isArray(payload?.data?.regex_scripts)) {
    return payload.data.regex_scripts;
  }
  if (payload && typeof payload === 'object') {
    return [payload];
  }
  return [];
}

function getRegexDisplayName(
  item: Partial<TavernRegex> & { name?: string; scriptName?: string; title?: string },
): string {
  const raw = String(item.script_name ?? item.scriptName ?? item.name ?? item.title ?? '').trim();
  return raw;
}

function getManagedRegexes(): TavernRegex[] {
  return getTavernRegexes().filter(item => item.script_name.startsWith(REGEX_PREFIX));
}

function getRegexById(regexId: string): TavernRegex | undefined {
  return getTavernRegexes().find(item => item.id === regexId);
}

async function promptText(title: string, defaultValue = ''): Promise<string | null> {
  const result = await SillyTavern.callGenericPopup(title, SillyTavern.POPUP_TYPE.INPUT, defaultValue, {
    okButton: '确认',
    cancelButton: '取消',
    rows: 3,
    wider: true,
  });
  if (result === false || result === undefined || result === null) {
    return null;
  }
  return String(result).trim();
}

async function importRegexFromFile(shell: JQuery<HTMLElement>): Promise<void> {
  const input = shell.find('input[data-role="regexFile"]')[0] as HTMLInputElement | undefined;
  if (!input?.files?.length) {
    return;
  }

  const file = input.files[0];
  let content = '';
  try {
    content = await file.text();
  } catch {
    toastr.error('读取文件失败');
    return;
  }

  const beforeIds = new Set(getTavernRegexes().map(item => item.id));

  let importedNames: string[] = [];
  try {
    const parsed = JSON.parse(content);
    const list = parseImportedRegexList(parsed);
    importedNames = list
      .map(item =>
        getRegexDisplayName(item as Partial<TavernRegex> & { name?: string; scriptName?: string; title?: string }),
      )
      .filter(name => name.length > 0);
  } catch {
    importedNames = [];
  }

  const imported = importRawTavernRegex(file.name, content);
  if (!imported) {
    toastr.error('导入失败，请确认使用酒馆原生正则导出文件');
    return;
  }

  await updateTavernRegexesWith(regexes => {
    let nameIndex = 0;
    return regexes.map(item => {
      const isNewById = !beforeIds.has(item.id);
      if (!isNewById) {
        return item;
      }

      const importedName = importedNames[nameIndex] ?? item.script_name;
      nameIndex += 1;

      return {
        ...item,
        script_name: ensureRegexPrefix(importedName),
      };
    });
  });

  const after = getManagedRegexes().length;
  toastr.success(`已导入，当前可管理状态栏正则 ${after} 条`);
}

async function getBindingLiveState(binding: StatusBarBinding): Promise<{
  worldbook_enabled: boolean | null;
  regex_enabled: boolean | null;
}> {
  let worldbookEnabled: boolean | null = null;
  let regexEnabled: boolean | null = null;

  try {
    const worldbook = await getWorldbook(binding.worldbook_name);
    const entry = worldbook.find(item => item.uid === binding.worldbook_entry_uid);
    if (entry) {
      worldbookEnabled = entry.enabled;
    }
  } catch {
    // ignore
  }

  const regex = getRegexById(binding.regex_id);
  if (regex) {
    regexEnabled = regex.enabled;
  }

  return {
    worldbook_enabled: worldbookEnabled,
    regex_enabled: regexEnabled,
  };
}

async function setBindingEnabled(binding: StatusBarBinding, enabled: boolean): Promise<void> {
  let worldbookMatched = false;
  let regexMatched = false;

  await updateWorldbookWith(binding.worldbook_name, worldbook => {
    return worldbook.map(entry => {
      if (entry.uid === binding.worldbook_entry_uid) {
        worldbookMatched = true;
        return { ...entry, enabled };
      }
      return entry;
    });
  });

  await updateTavernRegexesWith(regexes => {
    return regexes.map(regex => {
      if (regex.id === binding.regex_id) {
        regexMatched = true;
        return { ...regex, enabled, script_name: ensureRegexPrefix(regex.script_name) };
      }
      return regex;
    });
  });

  if (!worldbookMatched && !regexMatched) {
    throw new Error('未找到可切换的世界书条目或正则');
  }
}

function createManagerPanelShell(): JQuery<HTMLElement> {
  return $(`
    <div>
      <h3><i class="fa-solid fa-puzzle-piece"></i> 状态栏管理器</h3>

      <div style="display:flex; gap:14px; align-items:center; flex-wrap:wrap; margin:8px 0 12px;">
        <span role="button" tabindex="0" data-action="switchTab" data-tab="binding"><i class="fa-solid fa-link"></i> 绑定状态栏</span>
        <span role="button" tabindex="0" data-action="switchTab" data-tab="style"><i class="fa-solid fa-list"></i> 状态栏样式列表</span>
      </div>

      <div data-role="tab-binding">
        <h4>绑定状态栏</h4>
        <div>
          <label>世界书：</label>
          <select data-role="worldbook"></select>
        </div>
        <div>
          <label>世界书条目：</label>
          <select data-role="entry"></select>
        </div>
        <div>
          <span role="button" tabindex="0" data-action="addWorldbookRow"><i class="fa-solid fa-plus"></i> 增加世界书条目</span>
        </div>
        <div data-role="extraWorldbookRows"></div>
        <div style="margin-top:8px;">
          <label>状态栏正则：</label>
          <select data-role="regex"></select>
        </div>
        <div>
          <span role="button" tabindex="0" data-action="addRegexRow"><i class="fa-solid fa-plus"></i> 增加正则</span>
        </div>
        <div data-role="extraRegexRows"></div>
        <div style="display:flex; gap:14px; align-items:center; flex-wrap:wrap; margin-top:8px;">
          <span role="button" tabindex="0" data-action="pickRegexFile"><i class="fa-solid fa-file-import"></i> 导入正则文件</span>
          <span role="button" tabindex="0" data-action="createBinding"><i class="fa-solid fa-plus"></i> 创建绑定</span>
          <span role="button" tabindex="0" data-action="refresh"><i class="fa-solid fa-rotate"></i> 刷新</span>
        </div>
        <input type="file" data-role="regexFile" accept=".json,application/json" style="display:none;" />

      </div>

      <div data-role="tab-style" style="display:none;">
        <h4>状态栏样式列表</h4>
        <div data-role="styleList"></div>
      </div>
    </div>
  `);
}

function switchTab(shell: JQuery<HTMLElement>, tab: 'binding' | 'style'): void {
  const bindingTab = shell.find('[data-role="tab-binding"]');
  const styleTab = shell.find('[data-role="tab-style"]');

  if (tab === 'binding') {
    bindingTab.show();
    styleTab.hide();
  } else {
    bindingTab.hide();
    styleTab.show();
  }
}

function createWorldbookSelectorRow(): JQuery<HTMLElement> {
  return $(
    `<div data-worldbook-row-id="${SillyTavern.uuidv4()}" style="margin-top:8px;">
      <div>
        <label>世界书：</label>
        <select data-role="worldbook-extra"></select>
      </div>
      <div>
        <label>世界书条目：</label>
        <select data-role="entry-extra"></select>
      </div>
      <div>
        <span role="button" tabindex="0" data-action="removeWorldbookRow"><i class="fa-solid fa-trash"></i> 删除此世界书条目</span>
      </div>
    </div>`,
  );
}

function createRegexSelectorRow(): JQuery<HTMLElement> {
  return $(
    `<div data-regex-row-id="${SillyTavern.uuidv4()}" style="margin-top:8px;">
      <div>
        <label>状态栏正则：</label>
        <select data-role="regex-extra"></select>
      </div>
      <div>
        <span role="button" tabindex="0" data-action="removeRegexRow"><i class="fa-solid fa-trash"></i> 删除此正则</span>
      </div>
    </div>`,
  );
}

async function renderWorldbookOptions(shell: JQuery<HTMLElement>): Promise<void> {
  const names = getWorldbookNames();

  const populate = (select: JQuery<HTMLElement>) => {
    select.empty();
    if (names.length === 0) {
      select.append('<option value="">（无世界书）</option>');
      return;
    }
    for (const name of names) {
      select.append(`<option value="${name}">${name}</option>`);
    }
  };

  populate(shell.find('select[data-role="worldbook"]'));
  shell.find('select[data-role="worldbook-extra"]').each(function () {
    populate($(this));
  });
}

async function renderEntryOptions(shell: JQuery<HTMLElement>): Promise<void> {
  const populate = async (select: JQuery<HTMLElement>, worldbookName: string) => {
    select.empty();
    if (!worldbookName) {
      select.append('<option value="">（先选择世界书）</option>');
      return;
    }

    const entries = await getWorldbook(worldbookName);
    if (entries.length === 0) {
      select.append('<option value="">（该世界书无条目）</option>');
      return;
    }

    for (const entry of entries) {
      const displayName = entry.name || `未命名条目-${entry.uid}`;
      select.append(`<option value="${entry.uid}">${displayName} (uid=${entry.uid})</option>`);
    }
  };

  const mainWorldbookName = String(shell.find('select[data-role="worldbook"]').val() ?? '');
  await populate(shell.find('select[data-role="entry"]'), mainWorldbookName);

  const extraWorldbooks = shell.find('select[data-role="worldbook-extra"]');
  for (let i = 0; i < extraWorldbooks.length; i += 1) {
    const extraWorldbookSelect = $(extraWorldbooks[i]);
    const row = extraWorldbookSelect.closest('[data-worldbook-row-id]');
    const worldbookName = String(extraWorldbookSelect.val() ?? '');
    const entrySelect = row.find('select[data-role="entry-extra"]');
    await populate(entrySelect, worldbookName);
  }
}

function renderRegexOptions(shell: JQuery<HTMLElement>): void {
  const regexes = getManagedRegexes();

  const populate = (select: JQuery<HTMLElement>) => {
    select.empty();
    if (regexes.length === 0) {
      select.append('<option value="">（暂无状态栏正则，请先导入）</option>');
      return;
    }

    for (const regex of regexes) {
      select.append(`<option value="${regex.id}">${regex.script_name}</option>`);
    }
  };

  populate(shell.find('select[data-role="regex"]'));
  shell.find('select[data-role="regex-extra"]').each(function () {
    populate($(this));
  });
}

async function renderStyleList(shell: JQuery<HTMLElement>, settings: StatusBarScriptSettings): Promise<void> {
  const container = shell.find('[data-role="styleList"]');
  container.empty();

  if (settings.bindings.length === 0) {
    container.append('<div>暂无样式</div>');
    return;
  }

  const table = $(
    '<table><thead><tr><th>显示名</th><th>世界书</th><th>条目</th><th>正则名</th><th>同步开关</th><th>操作</th></tr></thead><tbody></tbody></table>',
  );
  const tbody = table.find('tbody');

  for (const item of settings.bindings) {
    const live = await getBindingLiveState(item);
    const bothEnabled = live.worldbook_enabled === true && live.regex_enabled === true;
    const row = $(
      `<tr>
        <td>${item.label}</td>
        <td>${item.worldbook_name}</td>
        <td>${item.worldbook_entry_name} (uid=${item.worldbook_entry_uid})</td>
        <td>${item.regex_script_name}</td>
        <td><span role="button" tabindex="0" data-action="toggleBinding" data-id="${item.id}"><i class="fa-solid fa-power-off"></i> ${bothEnabled ? '关闭' : '开启'}</span></td>
        <td>
          <span role="button" tabindex="0" data-action="renameStyle" data-id="${item.id}"><i class="fa-solid fa-pen"></i> 改名</span>
          <span role="button" tabindex="0" data-action="previewStyle" data-id="${item.id}"><i class="fa-solid fa-eye"></i> 预览</span>
          <span role="button" tabindex="0" data-action="deleteBinding" data-id="${item.id}"><i class="fa-solid fa-trash"></i> 删除</span>
        </td>
      </tr>`,
    );
    tbody.append(row);
  }

  container.append(table);
}

async function createBindingFromSelection(
  shell: JQuery<HTMLElement>,
  settings: StatusBarScriptSettings,
): Promise<void> {
  const worldbookSelections: Array<{ worldbookName: string; entryUid: number }> = [];
  const regexSelections: string[] = [];

  const worldbookName = String(shell.find('select[data-role="worldbook"]').val() ?? '');
  const entryUid = Number(shell.find('select[data-role="entry"]').val() ?? NaN);
  worldbookSelections.push({ worldbookName, entryUid });

  shell.find('[data-worldbook-row-id]').each(function () {
    const row = $(this);
    const extraWorldbookName = String(row.find('select[data-role="worldbook-extra"]').val() ?? '');
    const extraEntryUid = Number(row.find('select[data-role="entry-extra"]').val() ?? NaN);
    worldbookSelections.push({ worldbookName: extraWorldbookName, entryUid: extraEntryUid });
  });

  const regexId = String(shell.find('select[data-role="regex"]').val() ?? '');
  regexSelections.push(regexId);

  shell.find('[data-regex-row-id]').each(function () {
    const row = $(this);
    const extraRegexId = String(row.find('select[data-role="regex-extra"]').val() ?? '');
    regexSelections.push(extraRegexId);
  });

  const validWorldbookSelections = worldbookSelections.filter(
    item => item.worldbookName && Number.isInteger(item.entryUid),
  );
  const validRegexSelections = regexSelections.filter(item => item.length > 0);

  if (validWorldbookSelections.length === 0 || validRegexSelections.length === 0) {
    toastr.warning('请至少完整选择一条世界书条目，并至少选择一条正则');
    return;
  }

  const managedRegexes = getManagedRegexes();

  let createdCount = 0;
  for (const wbItem of validWorldbookSelections) {
    const entries = await getWorldbook(wbItem.worldbookName);
    const entry = entries.find(entryItem => entryItem.uid === wbItem.entryUid);
    if (!entry) {
      continue;
    }

    for (const regexIdItem of validRegexSelections) {
      const regex = managedRegexes.find(regexItem => regexItem.id === regexIdItem);
      if (!regex) {
        continue;
      }

      const duplicate = settings.bindings.find(
        binding =>
          binding.worldbook_name === wbItem.worldbookName &&
          binding.worldbook_entry_uid === wbItem.entryUid &&
          binding.regex_id === regexIdItem,
      );
      if (duplicate) {
        continue;
      }

      settings.bindings.push({
        id: SillyTavern.uuidv4(),
        label: `${wbItem.worldbookName} / ${entry.name || entry.uid}`,
        worldbook_name: wbItem.worldbookName,
        worldbook_entry_uid: entry.uid,
        worldbook_entry_name: entry.name || `未命名条目-${entry.uid}`,
        regex_id: regex.id,
        regex_script_name: regex.script_name,
      });
      createdCount += 1;
    }
  }

  if (createdCount === 0) {
    toastr.info('没有新增绑定（可能已存在或选择无效）');
    return;
  }

  await saveSettings(settings);
  toastr.success(`已创建 ${createdCount} 条绑定`);
}

function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const matched = trimmed.match(/^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```$/);
  if (matched) {
    return matched[1].trim();
  }
  return trimmed;
}

async function openRegexPreview(binding: StatusBarBinding): Promise<void> {
  const regex = getRegexById(binding.regex_id);
  if (!regex) {
    toastr.error('未找到对应正则');
    return;
  }

  const shell = $(
    `<div>
      <h4>${binding.label}</h4>
      <div data-role="previewBox"></div>
    </div>`,
  );

  const previewBox = shell.find('[data-role="previewBox"]');
  const raw = String(regex.replace_string ?? '');
  const html = stripCodeFence(raw);
  if (html.length === 0) {
    previewBox.text('该正则 replace_string 为空，暂无可预览内容。');
  } else {
    previewBox.html(html);
  }

  await SillyTavern.callGenericPopup(shell, SillyTavern.POPUP_TYPE.DISPLAY, '', {
    okButton: '关闭',
    leftAlign: true,
  });
}

async function refreshManagerView(shell: JQuery<HTMLElement>, settings: StatusBarScriptSettings): Promise<void> {
  await renderWorldbookOptions(shell);
  await renderEntryOptions(shell);
  renderRegexOptions(shell);
  await renderStyleList(shell, settings);
}

async function openManagerPanel(): Promise<void> {
  const settings = loadSettings();
  const shell = createManagerPanelShell();

  shell.on('change', 'select[data-role="worldbook"]', async () => {
    await renderEntryOptions(shell);
  });

  shell.on('change', 'select[data-role="worldbook-extra"]', async () => {
    await renderEntryOptions(shell);
  });

  shell.on('click', '[data-action="switchTab"]', function () {
    const tab = String($(this).data('tab') ?? 'binding');
    switchTab(shell, tab === 'style' ? 'style' : 'binding');
  });

  shell.on('click', '[data-action="pickRegexFile"]', () => {
    const input = shell.find('input[data-role="regexFile"]');
    input.val('');
    input.trigger('click');
  });

  shell.on('change', 'input[data-role="regexFile"]', async () => {
    await importRegexFromFile(shell);
    await refreshManagerView(shell, settings);
  });

  shell.on('click', '[data-action="addWorldbookRow"]', async () => {
    shell.find('[data-role="extraWorldbookRows"]').append(createWorldbookSelectorRow());
    await renderWorldbookOptions(shell);
    await renderEntryOptions(shell);
  });

  shell.on('click', '[data-action="removeWorldbookRow"]', async function () {
    $(this).closest('[data-worldbook-row-id]').remove();
  });

  shell.on('click', '[data-action="addRegexRow"]', async () => {
    shell.find('[data-role="extraRegexRows"]').append(createRegexSelectorRow());
    renderRegexOptions(shell);
  });

  shell.on('click', '[data-action="removeRegexRow"]', async function () {
    $(this).closest('[data-regex-row-id]').remove();
  });

  shell.on('click', '[data-action="createBinding"]', async () => {
    await createBindingFromSelection(shell, settings);
    await refreshManagerView(shell, settings);
  });

  shell.on('click', '[data-action="toggleBinding"]', async function () {
    const id = String($(this).data('id') ?? '');
    const binding = settings.bindings.find(item => item.id === id);
    if (!binding) {
      return;
    }

    const live = await getBindingLiveState(binding);
    const targetEnabled = !(live.worldbook_enabled === true && live.regex_enabled === true);
    try {
      await setBindingEnabled(binding, targetEnabled);
      toastr.success(`${binding.label} 已${targetEnabled ? '开启' : '关闭'}`);
    } catch (error) {
      console.error(error);
      toastr.error('同步开关失败');
    }

    await refreshManagerView(shell, settings);
  });

  shell.on('click', '[data-action="deleteBinding"]', async function () {
    const id = String($(this).data('id') ?? '');
    settings.bindings = settings.bindings.filter(item => item.id !== id);
    await saveSettings(settings);
    await refreshManagerView(shell, settings);
    toastr.success('绑定已删除');
  });

  shell.on('click', '[data-action="renameStyle"]', async function () {
    const id = String($(this).data('id') ?? '');
    const binding = settings.bindings.find(item => item.id === id);
    if (!binding) {
      return;
    }

    const renamed = await promptText('输入新的显示名', binding.label);
    if (!renamed) {
      return;
    }

    binding.label = renamed;
    await saveSettings(settings);
    await refreshManagerView(shell, settings);
    toastr.success('名称已更新');
  });

  shell.on('click', '[data-action="previewStyle"]', async function () {
    const id = String($(this).data('id') ?? '');
    const binding = settings.bindings.find(item => item.id === id);
    if (!binding) {
      return;
    }
    await openRegexPreview(binding);
  });

  shell.on('click', '[data-action="refresh"]', async () => {
    await refreshManagerView(shell, settings);
    toastr.info('已刷新');
  });

  shell.on('keydown', '[role="button"][data-action]', function (event) {
    if (event.key !== 'Enter' && event.key !== ' ') {
      return;
    }
    event.preventDefault();
    $(this).trigger('click');
  });

  await refreshManagerView(shell, settings);
  switchTab(shell, 'style');

  await SillyTavern.callGenericPopup(shell, SillyTavern.POPUP_TYPE.DISPLAY, '', {
    okButton: '关闭',
    wide: true,
    wider: true,
    large: true,
    leftAlign: true,
  });
}

function buildExtensionEntry(): JQuery<HTMLElement> {
  return $(
    `<div id="${EXT_ENTRY_ID}" role="button" tabindex="0"><i class="fa-solid fa-puzzle-piece"></i> ${SCRIPT_BUTTON_NAME}</div>`,
  )
    .on('click', async () => {
      await eventEmit(getButtonEvent(SCRIPT_BUTTON_NAME));
    })
    .on('keydown', async event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        await eventEmit(getButtonEvent(SCRIPT_BUTTON_NAME));
      }
    });
}

function findExtensionContainer(): JQuery<HTMLElement> {
  const candidates = [
    '#extensionsMenu',
    '#extensions-menu',
    '#extensions_dropdown',
    '#extensions_settings2',
    '.extensionsMenu',
    '.extensions-menu',
    '.drawer-content:has(.fa-solid), .drawer-content:has(.fa-regular)',
  ];

  for (const selector of candidates) {
    const target = $(selector).first();
    if (target.length > 0) {
      return target;
    }
  }

  return $();
}

function ensureExtensionEntry(): void {
  if ($(`#${EXT_ENTRY_ID}`).length > 0) {
    return;
  }

  const container = findExtensionContainer();
  if (container.length === 0) {
    return;
  }

  container.append(buildExtensionEntry());
}

$(() => {
  removeScriptLibraryButtons();

  eventOn(getButtonEvent(SCRIPT_BUTTON_NAME), async () => {
    try {
      await openManagerPanel();
    } catch (error) {
      console.error(error);
      toastr.error('状态栏管理器打开失败');
    }
  });

  ensureExtensionEntry();
  eventOn(tavern_events.APP_READY, ensureExtensionEntry);
  eventOn(tavern_events.EXTENSIONS_FIRST_LOAD, ensureExtensionEntry);

  const observer = new MutationObserver(() => {
    ensureExtensionEntry();
  });

  observer.observe(document.body, { childList: true, subtree: true });

  $(window).on('pagehide', () => {
    observer.disconnect();
    $(`#${EXT_ENTRY_ID}`).remove();
  });
});
