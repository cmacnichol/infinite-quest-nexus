import { campaignEmbeddingConfigSchema, illustrationConfigResponseSchema, illustrationConfigSchema, type CampaignSummary } from "@infinite-quest/contracts";
import { createStoryMemoryApi } from "@infinite-quest/client-web";
import { campaignApi, createCampaignSettingsScope, type CampaignSettingsContext } from "../campaign-editor-api";
import { chronicleEmbeddingConfigPayload, chronicleFields, embeddingProviderOptions, illustrationFields, illustrationPayload, providerOptions, storyBehaviorFields, storyMemorySettingsMarkup, storyMemoryGuidance } from "./campaign-fields";
import { createOwnerSettingsApis } from "./owner-settings-api";
import { safeSettingsReturn } from "./sections";

type Values = Record<string,string>;
type Save = (values: Values) => Promise<string>;
type UpdateInherited = (control: HTMLInputElement | HTMLSelectElement, update: () => void) => void;
function valuesOf(form: HTMLFormElement): Values {
  return Object.fromEntries(new FormData(form).entries()) as Values;
}
function sectionForm(title: string, fields: string, submit: string): string {
  return `<form class="campaign-form"><h3>${title}</h3><div class="campaign-field-grid">${fields}</div><div class="campaign-action-ledger"><button class="primary-action" type="submit">${submit}</button></div></form>`;
}

export function mountCampaignSettings(host: HTMLElement, campaigns: CampaignSummary[], requestedId: string | null, reloadCampaigns: (signal: AbortSignal) => Promise<CampaignSummary[]>) {
  const doc = host.ownerDocument;
  const win = doc.defaultView!;
  const scope = createCampaignSettingsScope(campaigns);
  const memory = createStoryMemoryApi();
  const owner = createOwnerSettingsApis();
  const dirty = new Set<HTMLFormElement>();
  let selected = "";
  const picker = doc.createElement("select");
  picker.setAttribute("aria-label", "Campaign");
  picker.append(new Option("Choose a campaign", ""));
  for (const campaign of campaigns) picker.append(new Option(campaign.title, campaign.id));
  const label = doc.createElement("label");
  label.className = "settings-campaign-selector";
  label.append("Campaign",picker);
  const panels = doc.createElement("div");
  panels.className = "settings-campaign-panels";
  host.append(label,panels);
  const beforeUnload = (event: BeforeUnloadEvent) => {
    if (dirty.size) { event.preventDefault(); event.returnValue = ""; }
  };
  win.addEventListener("beforeunload", beforeUnload);
  const back = safeSettingsReturn(new URL(win.location.href).searchParams.get("returnTo"));
  if (back) {
    const link = doc.createElement("a");
    link.href = back; link.textContent = back.startsWith("/nexus/") || back.startsWith("/app/campaigns/") ? "Return to Campaign Management" : "Return to Story";
    host.prepend(link);
  }
  async function choose(id: string, refresh = true) {
    const context = scope.select(id);
    selected = context?.campaignId ?? "";
    picker.value = selected;
    dirty.clear();
    panels.replaceChildren();
    if (!context) {
      panels.textContent = id ? "This campaign is unavailable to your account. Choose one of your campaigns." : "Choose a campaign before editing its settings.";
      return;
    }
    try {
      panels.textContent = "Loading campaign…";
      const available = refresh ? await reloadCampaigns(context.signal) : campaigns;
      if (!context.current()) return;
      const campaign = available.find(item => item.id === id);
      if (!campaign) {
        panels.textContent = "This campaign is unavailable to your account. Choose one of your campaigns.";
        return;
      }
      panels.replaceChildren();
      loadSections(context, campaign);
    } catch {
      if (context.current()) panels.textContent = "Campaign settings could not be loaded. Select the campaign again to retry.";
    }
  }
  picker.addEventListener("change", () => {
    if (dirty.size && !win.confirm("Discard unsaved changes to this campaign?")) { picker.value = selected; return; }
    void choose(picker.value);
    const url = new URL(win.location.href);
    if (selected) url.searchParams.set("campaignId", selected); else url.searchParams.delete("campaignId");
    win.history.replaceState(null,"",url.pathname + url.search);
    for (const anchor of doc.querySelectorAll<HTMLAnchorElement>(".settings-nav a")) {
      const next = new URL(anchor.href);
      if (selected) next.searchParams.set("campaignId", selected); else next.searchParams.delete("campaignId");
      anchor.href = next.pathname + next.search;
    }
  });
  function loadSections(ctx: CampaignSettingsContext, campaign: CampaignSummary) {
    const { campaignId: id, signal } = ctx;
    const assignments = new EventTarget();
    const providers = owner.providers.list(signal).then(response => response.providers);
    const path = "/app/campaigns/" + id;
    const links = doc.createElement("nav");
    links.setAttribute("aria-label", "Campaign workspaces");
    for (const [name, destination] of [
      ["Open campaign editor",path], ["Characters","/app/story/"+id+"#characters"], ["Data Transfer","/app/data-transfer"],
      ["Chronicle indexing and context preview",path+"/chronicle"], ["Historical illustrations",path+"/illustrations"],
      ["Illustration refinement prompt","/app/settings?section=prompts&campaignId="+id+"&prompt=illustration_refinement"]
    ]) {
      const link = doc.createElement("a"); link.href = destination!; link.textContent = name!; links.append(link);
    }
    function section(name: string, build: (container: HTMLElement, updateInherited: UpdateInherited) => Promise<Save>) {
      const container = doc.createElement("section");
      const groupIds: Record<string,string> = {"Story behavior":"story","Story Memory":"memory","Provider assignments":"assignments","Chronicle":"chronicle","Illustrations":"illustrations"};
      container.id = groupIds[name]!;
      const status = doc.createElement("p");
      status.setAttribute("role","status");
      container.append(status);
      panels.append(container);
      async function load() {
        status.textContent = "Loading " + name + "…";
        try {
          let baseline: Values | undefined;
          let syncDraft: (() => void) | undefined;
          const updateInherited: UpdateInherited = (control, update) => {
            if (baseline && control.value !== baseline[control.name]) return;
            update();
            if (baseline) baseline[control.name] = control.value;
            syncDraft?.();
          };
          const save = await build(container, updateInherited);
          if (!ctx.current()) return;
          const form = container.querySelector("form")!;
          form.append(status);
          if (win.location.hash === "#" + container.id) container.scrollIntoView();
          status.textContent = "";
          const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
          baseline = valuesOf(form);
          let busy = false;
          function sync() {
            const changed = JSON.stringify(valuesOf(form)) !== JSON.stringify(baseline);
            if (changed) dirty.add(form); else dirty.delete(form);
            submit.disabled = busy || !changed;
          }
          syncDraft = sync;
          form.addEventListener("input", sync);
          form.addEventListener("change",sync);
          sync();
          form.addEventListener("submit", async event => {
            event.preventDefault();
            if (!ctx.current() || busy || !dirty.has(form) || !form.reportValidity()) return;
            const submitted = valuesOf(form);
            busy = true; sync(); status.textContent = "Saving…";
            try {
              const result = await save(submitted);
              if (!ctx.current()) return;
              baseline = submitted;
              status.textContent = result;
            } catch (error) {
              if (ctx.current()) status.textContent = error instanceof Error ? error.message : "Save failed.";
            } finally {
              if (ctx.current()) { busy = false; sync(); }
            }
          });
        } catch (error) {
          if (!ctx.current()) return;
          container.replaceChildren(status);
          status.textContent = name + " unavailable. " + (error instanceof Error ? error.message : "Reload Settings to retry.");
        }
      }
      void load();
    }
    function modelInventory(container: HTMLElement, role: "image" | "embedding", providerId: () => string | null) {
      const field = container.querySelector<HTMLInputElement>("[name=model]")!;
      const provider = container.querySelector<HTMLSelectElement>("[name=providerProfileId]")!;
      const choices = doc.createElement("datalist");
      choices.id = "campaign-" + role + "-models";
      field.setAttribute("list",choices.id);
      const load = doc.createElement("button");
      load.type = "button";
      load.textContent = "Load " + role + " models";
      const status = doc.createElement("span");
      status.setAttribute("role","status");
      let revision = 0;
      const refresh = () => { ++revision; choices.replaceChildren(); status.textContent = ""; load.disabled = !providerId(); };
      provider.addEventListener("change", refresh);
      refresh();
      load.addEventListener("click", async () => {
        const requested = providerId();
        if (!ctx.current() || !requested) return;
        const epoch = ++revision;
        const current = () => ctx.current() && revision === epoch && providerId() === requested;
        load.disabled = true;
        status.textContent = "Loading models…";
        try {
          const {models} = await owner.providers.campaignModels(requested,role,signal);
          if (!current()) return;
          choices.replaceChildren(...models.map(model => new Option(model.displayName,model.id)));
          status.textContent = models.length ? "Models available in the model field." : "No models available.";
        } catch (error) {
          if (current()) status.textContent = error instanceof Error ? error.message : "Model inventory unavailable.";
        } finally { if (ctx.current() && revision === epoch) load.disabled = !providerId(); }
      });
      field.parentElement!.after(choices,load,status);
      return refresh;
    }
    section("Story behavior", async container => {
      const state = await campaignApi.get<{revision:number}>(id, "/state",signal);
      if (!Number.isSafeInteger(state.revision) || state.revision < 0) throw new Error("Reload the campaign state.");
      container.innerHTML = sectionForm("Story behavior", storyBehaviorFields(campaign,[],false), "Save story behavior");
      const help = doc.createElement("p");
      help.textContent = "User Profile sets the turn input style for new campaigns. This campaign keeps its own saved style. The text provider limits the usable Story context.";
      container.querySelector("h3")!.after(help);
      return async values => {
        const payload: Record<string,unknown> = {};
        const style = values.turnControlStyle === "flexible_action" && campaign.turnControlStyle === "action_only" ? "action_only" : values.turnControlStyle;
        if (style !== campaign.turnControlStyle) Object.assign(payload, {turnControlStyle:style, expectedTurnControlStyle:campaign.turnControlStyle, expectedActiveTurnNumber:campaign.activeTurnNumber, expectedStateRevision:state.revision});
        if (values.storyLengthProfile !== campaign.storyLengthProfile) payload.storyLengthProfile = values.storyLengthProfile;
        if (Number(values.storyContextBudgetTokens) !== campaign.storyContextBudgetTokens) payload.storyContextBudgetTokens = Number(values.storyContextBudgetTokens);
        await campaignApi.saveSettings(id,"behavior",payload,signal);
        if (ctx.current()) Object.assign(campaign,{turnControlStyle:style, storyLengthProfile:values.storyLengthProfile, storyContextBudgetTokens:Number(values.storyContextBudgetTokens)});
        return "Story behavior saved.";
      };
    });
    section("Story Memory", async container => {
      let settings = await memory.get(id,signal);
      container.innerHTML = storyMemorySettingsMarkup(settings,false);
      const level = container.querySelector<HTMLSelectElement>("[name=storyMemoryLevel]")!;
      const review = container.querySelector<HTMLInputElement>("[name=continuityReviewEnabled]")!;
      level.addEventListener("change",() => { review.disabled = level.value !== "max"; if (review.disabled) review.checked = false; });
      return async values => {
        const next = settings.availableLevels.find(candidate => candidate === values.storyMemoryLevel);
        if (!next) throw new Error("This memory level is unavailable.");
        settings = await memory.update(id,{level:next,continuityReviewEnabled:next === "max" && values.continuityReviewEnabled === "on"},signal);
        if (ctx.current()) {
          for (const option of level.options) option.disabled = !settings.availableLevels.some(value => value === option.value);
          const guidance = container.querySelector("[data-story-memory-guidance]");
          if (guidance) guidance.textContent = storyMemoryGuidance(settings);
        }
        return "Campaign memory level saved.";
      };
    });
    section("Provider assignments",async container => {
      const list = await providers;
      function select(role: "text" | "image", current: string | null) {
        return `<label class="campaign-field"><span>${role === "text"?"Text":"Image"} provider assignment</span><select name="${role}ProviderProfileId">${providerOptions(list,role,current,"Use owner default")}</select></label>`;
      }
      container.innerHTML = sectionForm("Provider assignments",select("text",campaign.textProviderProfileId)+select("image",campaign.imageProviderProfileId),"Save provider assignments");
      const note = doc.createElement("p");
      note.textContent = "Direct image requests use the campaign image assignment unless they request another profile. Leave an assignment empty to use your provider defaults.";
      container.querySelector("h3")!.after(note);
      return async values => {
        const patch: Record<string,string | null> = {};
        for (const key of ["textProviderProfileId","imageProviderProfileId"] as const) {
          const value = values[key] || null;
          if (campaign[key] !== value) patch[key] = value;
        }
        await campaignApi.saveSettings(id,"behavior",patch,signal);
        if (ctx.current()) {
          Object.assign(campaign,patch);
          for (const key of Object.keys(patch)) assignments.dispatchEvent(new Event(key));
        }
        return "Campaign provider assignments saved.";
      };
    });
    section("Chronicle",async (container, updateInherited) => {
      const [raw,list] = await Promise.all([campaignApi.get<Record<string,unknown>>(id,"/memory/embedding-config",signal),providers]);
      if (typeof raw.enabled !== "boolean" || typeof raw.retrievalImplementation !== "string") throw new Error("Reload the saved retrieval configuration.");
      const config = campaignEmbeddingConfigSchema.parse(raw);
      container.innerHTML = sectionForm("Chronicle",chronicleFields(config,list,campaign.textProviderProfileId),"Save &amp; index");
      const provider = container.querySelector<HTMLSelectElement>("[name=providerProfileId]")!;
      const refreshInventory = modelInventory(container,"embedding",() => provider.value || null);
      let savedProvider = config.providerProfileId;
      assignments.addEventListener("textProviderProfileId", () => {
        if (savedProvider || list.some(item => item.enabled && item.providerRole === "embedding")) return;
        updateInherited(provider, () => {
          provider.innerHTML = embeddingProviderOptions(list,null,campaign.textProviderProfileId);
          refreshInventory();
        });
      });
      return async values => {
        const payload = campaignEmbeddingConfigSchema.parse(chronicleEmbeddingConfigPayload(values));
        if (payload.enabled && !payload.providerProfileId) throw new Error("Choose an eligible embedding provider.");
        const saved = await campaignApi.saveSettings<{jobId:string|null}>(id,"chronicle",payload,signal);
        savedProvider = payload.providerProfileId;
        return saved.jobId ? "Semantic Retrieval saved. Indexing queued." : "Semantic Retrieval saved.";
      };
    });
    section("Illustrations",async (container, updateInherited) => {
      const [raw,list] = await Promise.all([campaignApi.get(id,"/illustration-config",signal), providers]);
      const config = illustrationConfigResponseSchema.parse(raw);
      container.innerHTML = sectionForm("Illustrations",illustrationFields(config,list,true),"Save illustration settings");
      const note = doc.createElement("p");
      note.textContent = "Illustration segments use their saved provider first, then the campaign image assignment. Automatic generation requires a saved segment provider.";
      container.querySelector("h3")!.after(note);
      const imageProviders = list.filter(provider => provider.enabled && provider.providerRole === "image");
      const provider = container.querySelector<HTMLSelectElement>("[name=providerProfileId]")!;
      const count = container.querySelector<HTMLInputElement>("[name=imagesPerSegment]")!;
      const imageProvider = () => {
        const selectedId = provider.value || campaign.imageProviderProfileId;
        if (selectedId) return imageProviders.find(item => item.id === selectedId);
        return imageProviders.find(item => item.isDefault) ?? (imageProviders.length === 1 ? imageProviders[0] : undefined);
      };
      const refreshInventory = modelInventory(container,"image",() => imageProvider()?.id ?? null);
      let savedConfig = config.updatedAt !== null;
      let effectiveProviderId = imageProvider()?.id;
      function updateCount() {
        if (!savedConfig) updateInherited(count, () => {
          count.value = imageProvider()?.configuration.defaultImageCount === 2 ? "2" : "1";
        });
      }
      function updateImageOptions() {
        if (effectiveProviderId === imageProvider()?.id) return;
        effectiveProviderId = imageProvider()?.id;
        refreshInventory();
        updateCount();
      }
      updateCount();
      provider.addEventListener("change", updateImageOptions);
      assignments.addEventListener("imageProviderProfileId", updateImageOptions);
      return async values => {
        const generating = ["generate_only","library_then_generate"].includes(values.sourcePolicy);
        const fields = illustrationPayload(values,config.refinementPrompt);
        if (generating && !fields.providerProfileId) throw new Error("Choose a segment image provider before enabling automatic generation.");
        const payload = illustrationConfigSchema.parse(fields);
        await campaignApi.saveSettings(id,"illustrations",payload,signal);
        savedConfig = true;
        return "Illustration settings saved.";
      };
    });
    panels.append(links);
  }
  void choose(requestedId ?? "", false);
  return {dispose() { scope.dispose(); dirty.clear(); win.removeEventListener("beforeunload",beforeUnload); host.replaceChildren(); }};
}
