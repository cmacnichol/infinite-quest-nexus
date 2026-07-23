const PHOTOSWIPE_LIGHTBOX_URL = "/vendor/photoswipe/photoswipe-lightbox.esm.js";
const PHOTOSWIPE_CORE_URL = "/vendor/photoswipe/photoswipe.esm.js";

function debounce(callback, delay) {
  let timeout;
  return (...args) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => callback(...args), delay);
  };
}

function setOptions(select, values, selected = "") {
  for (const value of values) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value.replaceAll("_", " ").replace(/^./, (character) => character.toUpperCase());
    option.selected = value === selected;
    select.append(option);
  }
}

function createFilterUi(container) {
  container.replaceChildren();
  const form = document.createElement("form");
  form.className = "image-library-filters";
  form.setAttribute("role", "search");
  form.innerHTML = `
    <label class="image-library-search"><span>Search image metadata</span><input name="q" type="search" maxlength="500" placeholder="Title, caption, tags, or prompt"></label>
    <label><span>Scope</span><select name="scope"><option value="all">All authorized images</option><option value="campaign">Current campaign</option><option value="world">Current world</option><option value="owner_library">Personal library</option></select></label>
    <label><span>Origin</span><select name="origin"><option value="">Any origin</option></select></label>
    <label><span>Review</span><select name="reviewStatus"><option value="">Any review state</option></select></label>
    <label><span>Sort</span><select name="sort"><option value="newest">Newest</option><option value="oldest">Oldest</option><option value="title">Title</option><option value="most_used">Most used</option></select></label>
    <details class="image-library-more-filters"><summary>More filters</summary><div>
      <label><span>Tags</span><input name="tags" maxlength="1000" placeholder="portrait, night"></label>
      <label><span>Provider</span><input name="provider" maxlength="500" placeholder="sogni"></label>
      <label><span>Model</span><input name="model" maxlength="500"></label>
      <label><span>Entity IDs</span><input name="entityIds" maxlength="1000" placeholder="character:lyra"></label>
      <label><span>Location IDs</span><input name="locationIds" maxlength="1000" placeholder="location:violet-arch"></label>
      <label><span>Reuse scope</span><select name="reuseScope"><option value="">Any reuse scope</option></select></label>
      <label><span>Aspect</span><select name="aspect"><option value="">Any aspect</option><option value="portrait">Portrait</option><option value="square">Square</option><option value="landscape">Landscape</option><option value="unknown">Unknown</option></select></label>
      <label><span>Created after</span><input name="createdFrom" type="date"></label>
      <label><span>Created before</span><input name="createdTo" type="date"></label>
      <label class="image-library-check"><input name="favorite" type="checkbox"><span>Favorites only</span></label>
      <label class="image-library-check"><input name="eligible" type="checkbox"><span>Automatic reuse eligible</span></label>
    </div></details>
    <div class="image-library-filter-actions"><button type="reset">Clear all</button></div>`;
  setOptions(form.elements.origin, ["generated", "imported", "uploaded"]);
  setOptions(form.elements.reviewStatus, ["unreviewed", "eligible", "restricted", "blocked"]);
  setOptions(form.elements.reuseScope, ["private", "campaign", "world", "owner_library"]);
  const chips = document.createElement("div");
  chips.className = "image-library-filter-chips";
  chips.setAttribute("aria-label", "Active image filters");
  container.append(form, chips);
  return { form, chips };
}

function queryValue(form, name) {
  const field = form.elements[name];
  if (!field) return "";
  if (field.type === "checkbox") return field.checked ? "true" : "";
  return String(field.value || "").trim();
}

function dateBoundary(value, endOfDay) {
  if (!value) return "";
  return new Date(`${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`).toISOString();
}

async function api(path, options = {}) {
  const response = await fetch(path, { headers: { "Content-Type": "application/json", ...(options.headers || {}) }, ...options });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || body.error || `Request failed (${response.status}).`);
  return body;
}

export function createImageLibraryBrowser({ dialog, grid, status, filterContainer, loadMore, closeButton }) {
  const { form, chips } = createFilterUi(filterContainer);
  let assets = [];
  let nextCursor = null;
  let requestVersion = 0;
  let abortController = null;
  let invocation = { mode: "browse", onSelect: null, context: {} };
  let lightbox = null;
  let metadataDialog = null;

  function updateFacetLabels(facets = {}) {
    for (const [fieldName, facetName] of [["origin", "origin"], ["reviewStatus", "reviewStatus"], ["reuseScope", "reuseScope"]]) {
      const select = form.elements[fieldName];
      const counts = facets[facetName] || {};
      for (const option of select.options) {
        if (!option.value) continue;
        const label = option.value.replaceAll("_", " ").replace(/^./, (character) => character.toUpperCase());
        option.textContent = counts[option.value] === undefined ? label : `${label} (${counts[option.value]})`;
      }
    }
  }

  function ensureMetadataDialog() {
    if (metadataDialog) return metadataDialog;
    metadataDialog = document.createElement("dialog");
    metadataDialog.className = "image-metadata-dialog";
    metadataDialog.innerHTML = `<form method="dialog" class="image-metadata-form">
      <h3>Edit image metadata</h3>
      <label><span>Title</span><input name="title" maxlength="300"></label>
      <label><span>Caption</span><textarea name="caption" maxlength="2000" rows="3"></textarea></label>
      <label><span>Tags</span><input name="tags" maxlength="1000" placeholder="portrait, night"></label>
      <label><span>Reuse scope</span><select name="reuseScope"><option value="private">Private</option><option value="campaign">Campaign</option><option value="world">World</option><option value="owner_library">Personal library</option></select></label>
      <label><span>Review status</span><select name="reviewStatus"><option value="unreviewed">Unreviewed</option><option value="eligible">Eligible</option><option value="restricted">Restricted</option><option value="blocked">Blocked</option></select></label>
      <label class="image-library-check"><input name="automaticReuseEnabled" type="checkbox"><span>Eligible for automatic reuse</span></label>
      <label class="image-library-check"><input name="favorite" type="checkbox"><span>Favorite</span></label>
      <p class="status" role="status" aria-live="polite"></p>
      <div class="image-metadata-actions"><button value="cancel" type="button">Cancel</button><button class="primary" value="save" type="submit">Save metadata</button></div>
    </form>`;
    document.body.append(metadataDialog);
    metadataDialog.querySelector('[value="cancel"]').addEventListener("click", () => metadataDialog.close());
    return metadataDialog;
  }

  async function editMetadata(asset) {
    const editor = ensureMetadataDialog();
    const editorForm = editor.querySelector("form");
    editorForm.elements.title.value = asset.title || "";
    editorForm.elements.caption.value = asset.caption || "";
    editorForm.elements.tags.value = (asset.tags || []).join(", ");
    editorForm.elements.reuseScope.value = asset.reuseScope;
    editorForm.elements.reviewStatus.value = asset.reviewStatus;
    editorForm.elements.automaticReuseEnabled.checked = asset.automaticReuseEnabled;
    editorForm.elements.favorite.checked = asset.favorite;
    editorForm.querySelector(".status").textContent = "";
    editorForm.onsubmit = async (event) => {
      event.preventDefault();
      const save = editorForm.querySelector('[value="save"]');
      save.disabled = true;
      try {
        await api(`/api/v1/assets/${asset.id}/library-metadata`, {
          method: "PATCH",
          body: JSON.stringify({
            expectedRevision: asset.metadataRevision,
            title: editorForm.elements.title.value,
            caption: editorForm.elements.caption.value,
            tags: editorForm.elements.tags.value.split(",").map((tag) => tag.trim()).filter(Boolean),
            reuseScope: editorForm.elements.reuseScope.value,
            reviewStatus: editorForm.elements.reviewStatus.value,
            automaticReuseEnabled: editorForm.elements.automaticReuseEnabled.checked,
            favorite: editorForm.elements.favorite.checked
          })
        });
        editor.close();
        await load(false);
      } catch (error) {
        editorForm.querySelector(".status").textContent = error.message || String(error);
      } finally {
        save.disabled = false;
      }
    };
    editor.showModal();
    editorForm.elements.title.focus();
  }

  function parameters(cursor = "") {
    const params = new URLSearchParams({ limit: "40", sort: queryValue(form, "sort") || "newest" });
    for (const name of ["q", "origin", "tags", "entityIds", "locationIds", "provider", "model", "reviewStatus", "reuseScope", "aspect"]) {
      const value = queryValue(form, name);
      if (value) params.set(name, value);
    }
    for (const name of ["favorite", "eligible"]) if (queryValue(form, name)) params.set(name, "true");
    const context = invocation.context || {};
    let scope = queryValue(form, "scope") || "all";
    if (scope === "campaign" && !context.campaignId) scope = "all";
    if (scope === "world" && !context.worldId) scope = "all";
    params.set("scope", scope);
    if (scope === "campaign" && context.campaignId) params.set("campaignId", context.campaignId);
    if (scope === "world" && context.worldId) params.set("worldId", context.worldId);
    const createdFrom = dateBoundary(queryValue(form, "createdFrom"), false);
    const createdTo = dateBoundary(queryValue(form, "createdTo"), true);
    if (createdFrom) params.set("createdFrom", createdFrom);
    if (createdTo) params.set("createdTo", createdTo);
    if (cursor) params.set("cursor", cursor);
    return params;
  }

  function renderChips() {
    chips.replaceChildren();
    const ignored = new Set(["sort"]);
    for (const field of form.elements) {
      if (!field.name || ignored.has(field.name) || (field.type === "checkbox" ? !field.checked : !field.value)) continue;
      if (field.name === "scope" && field.value === "all") continue;
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "image-library-filter-chip";
      const label = field.closest("label")?.querySelector("span")?.textContent || field.name;
      chip.textContent = `${label}: ${field.type === "checkbox" ? "yes" : field.value} ×`;
      chip.addEventListener("click", () => {
        if (field.type === "checkbox") field.checked = false;
        else field.value = field.name === "scope" ? "all" : "";
        void load(false);
      });
      chips.append(chip);
    }
  }

  async function select(asset, button) {
    if (!invocation.onSelect) return;
    button?.setAttribute("aria-busy", "true");
    if (button) button.disabled = true;
    try {
      await invocation.onSelect(asset);
      lightbox?.pswp?.close();
      dialog.close();
    } catch (error) {
      status.className = "status error";
      status.textContent = error.message || String(error);
      if (button) button.disabled = false;
    } finally {
      button?.removeAttribute("aria-busy");
    }
  }

  async function openViewer(index, originElement) {
    const { default: PhotoSwipeLightbox } = await import(PHOTOSWIPE_LIGHTBOX_URL);
    lightbox?.destroy();
    const itemData = (asset) => ({
      id: asset.id,
      src: asset.url,
      msrc: asset.thumbnailUrl || asset.url,
      width: asset.width || 1200,
      height: asset.height || 1200,
      alt: asset.alt || asset.title || "Retained story illustration",
      asset
    });
    const dataSource = assets.map(itemData);
    const frozenParameters = parameters();
    let viewerPrefetching = false;
    lightbox = new PhotoSwipeLightbox({ dataSource, pswpModule: () => import(PHOTOSWIPE_CORE_URL), preload: [1, 2] });
    lightbox.on("uiRegister", () => {
      lightbox.pswp.ui.registerElement({
        name: "nexus-caption",
        order: 9,
        isButton: false,
        appendTo: "root",
        onInit: (element, pswp) => {
          element.className = "pswp__nexus-caption";
          const update = () => {
            const asset = pswp.currSlide?.data?.asset;
            element.replaceChildren();
            if (!asset) return;
            const title = document.createElement("strong");
            title.textContent = asset.title || "Untitled image";
            const details = document.createElement("span");
            details.textContent = [asset.caption, asset.tags?.length ? `Tags: ${asset.tags.join(", ")}` : "", asset.model || "", asset.width && asset.height ? `${asset.width}×${asset.height}` : ""].filter(Boolean).join(" · ");
            element.append(title, details);
          };
          pswp.on("change", update);
          update();
        }
      });
      if (invocation.onSelect) {
        lightbox.pswp.ui.registerElement({
          name: "nexus-use-image",
          order: 8,
          isButton: true,
          tagName: "button",
          html: "Use this image",
          ariaLabel: "Use this image",
          onClick: (_event, element, pswp) => void select(pswp.currSlide?.data?.asset, element)
        });
      }
    });
    lightbox.on("change", async () => {
      const pswp = lightbox?.pswp;
      if (!pswp || viewerPrefetching || !nextCursor || pswp.currIndex < dataSource.length - 3) return;
      viewerPrefetching = true;
      try {
        const pageParameters = new URLSearchParams(frozenParameters);
        pageParameters.set("cursor", nextCursor);
        const body = await api(`/api/v1/assets?${pageParameters}`);
        const additions = body.assets || [];
        assets.push(...additions);
        dataSource.push(...additions.map(itemData));
        nextCursor = body.nextCursor || null;
        render();
        loadMore.hidden = !nextCursor;
        status.textContent = `${body.total || assets.length} matching images; ${assets.length} loaded.`;
        pswp.ui?.update();
      } catch (error) {
        status.className = "status error";
        status.textContent = `Could not load more images: ${error.message || String(error)}`;
      } finally {
        viewerPrefetching = false;
      }
    });
    lightbox.on("close", () => originElement?.focus());
    lightbox.init();
    lightbox.loadAndOpen(index);
  }

  function render() {
    grid.replaceChildren();
    if (!assets.length) {
      const empty = document.createElement("p");
      empty.className = "image-library-empty";
      empty.textContent = "No authorized images match these filters.";
      grid.append(empty);
      return;
    }
    assets.forEach((asset, index) => {
      const card = document.createElement("article");
      card.className = "asset-library-item";
      const open = document.createElement("button");
      open.type = "button";
      open.className = "asset-library-preview";
      open.setAttribute("aria-label", `Open ${asset.title || "retained image"}`);
      const image = document.createElement("img");
      image.src = asset.thumbnailUrl || asset.url;
      image.alt = asset.alt || "";
      image.loading = "lazy";
      const title = document.createElement("strong");
      title.textContent = asset.title || "Untitled image";
      const detail = document.createElement("span");
      detail.textContent = `${new Date(asset.createdAt).toLocaleString()} · ${asset.origin.replaceAll("_", " ")}`;
      open.append(image, title, detail);
      open.addEventListener("click", () => void openViewer(index, open));
      card.append(open);
      if (invocation.onSelect) {
        const use = document.createElement("button");
        use.type = "button";
        use.className = "asset-library-use";
        use.textContent = "Use image";
        use.addEventListener("click", () => void select(asset, use));
        card.append(use);
      }
      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "asset-library-edit";
      edit.textContent = "Edit metadata";
      edit.addEventListener("click", () => void editMetadata(asset));
      card.append(edit);
      const direct = document.createElement("a");
      direct.className = "asset-library-direct";
      direct.href = asset.url;
      direct.target = "_blank";
      direct.rel = "noopener";
      direct.textContent = "Open full-size";
      card.append(direct);
      grid.append(card);
    });
  }

  async function load(append) {
    const version = ++requestVersion;
    abortController?.abort();
    abortController = new AbortController();
    if (!append) {
      assets = [];
      nextCursor = null;
      grid.replaceChildren();
      status.textContent = "Loading retained images…";
    }
    try {
      const response = await fetch(`/api/v1/assets?${parameters(append ? nextCursor : "")}`, { signal: abortController.signal });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.message || body.error || `Request failed (${response.status}).`);
      if (version !== requestVersion) return;
      assets = append ? [...assets, ...(body.assets || [])] : (body.assets || []);
      nextCursor = body.nextCursor || null;
      render();
      renderChips();
      updateFacetLabels(body.facets);
      loadMore.hidden = !nextCursor;
      status.className = "status";
      status.textContent = `${body.total || 0} matching image${body.total === 1 ? "" : "s"}; ${assets.length} loaded.`;
    } catch (error) {
      if (error.name === "AbortError") return;
      status.className = "status error";
      status.textContent = error.message || String(error);
    }
  }

  const debouncedLoad = debounce(() => void load(false), 250);
  form.addEventListener("input", debouncedLoad);
  form.addEventListener("change", () => void load(false));
  form.addEventListener("submit", (event) => { event.preventDefault(); void load(false); });
  form.addEventListener("reset", () => setTimeout(() => void load(false), 0));
  loadMore.addEventListener("click", () => nextCursor && void load(true));
  closeButton.addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => lightbox?.pswp?.close());

  return {
    async open(options = {}) {
      invocation = { mode: options.mode || "browse", onSelect: options.onSelect || null, context: options.context || {} };
      if (invocation.context.campaignId) form.elements.scope.value = "campaign";
      else if (invocation.context.worldId) form.elements.scope.value = "world";
      else form.elements.scope.value = "all";
      dialog.showModal();
      await load(false);
      form.elements.q.focus();
    },
    refresh: () => load(false)
  };
}

export { api as imageLibraryApi };
