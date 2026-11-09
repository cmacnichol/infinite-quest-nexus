import { expect, test, type Page } from "@playwright/test";
import { quietLeafApiPayloads } from "../fixtures/quiet-leaf-payloads.js";

const base = `http://127.0.0.1:${process.env.PLAYWRIGHT_WEB_NEXT_PORT ?? "43174"}`;
const mode = process.env.VITE_UI_COMPONENTS === "web-awesome" ? "web-awesome" : "native";
const fixture = quietLeafApiPayloads();
const a = fixture.campaignId;
const b = "22222222-2222-4222-8222-222222222222";
const foreign = "99999999-9999-4999-8999-999999999999";
const rows = [fixture.campaigns.campaigns[0]!, {...fixture.campaigns.campaigns[0]!, id:b, title:"Second story"}];
const level = {level:"standard", reviewMode:"off", availableLevels:["off","standard","max"]};
const config = {enabled:false, providerProfileId:null, model:"fixture", batchSize:16, documentPrefix:null, queryPrefix:null, retrievalImplementation:"legacy_hybrid", retrievalShadowEnabled:false};
const profileRow = {baseUrl:"https://fixture.invalid",providerType:"openai_compatible",defaultModel:"fixture",contextWindowTokens:32000,maxOutputTokens:2048,temperature:1,requestTimeoutMs:30000,configuration:{},enabled:true,isDefault:true,healthStatus:"unknown",consecutiveFailures:0,lastHealthCheckAt:null,lastHealthError:null,hasApiKey:false,createdAt:"2026-11-01T00:00:00.000Z",updatedAt:"2026-11-01T00:00:00.000Z"};
async function setup(page: Page) {
  const writes: {path:string; body:Record<string, unknown>}[] = [];
  const reads: string[] = [];
  await page.route("**/api/v1/**", async route => {
    const path = new URL(route.request().url()).pathname.replace("/api/v1","");
    if (route.request().method() !== "GET") {
      const body = route.request().postDataJSON();
      writes.push({path,body});
      return route.fulfill({json:path.endsWith("/story-memory") ? {...level,level:body.level} : {...body}});
    }
    reads.push(path);
    const data = path === "/session" ? fixture.session : path === "/campaigns" ? {campaigns:rows} :
      path === "/providers" ? {providers:[]} : path.endsWith("/state") ? {revision:4} :
      path.endsWith("/illustration-config") ? {...fixture.illustrationConfig,artStyle:path.includes(b)?"B watercolor":"A ink"} :
      path.endsWith("/story-memory") ? level : path.endsWith("/embedding-config") ? config : {};
    return route.fulfill({json:data});
  });
  return {writes,reads};
}
function url(id:string, back?:string) {
  return base+"/app/settings?"+new URLSearchParams({section:"campaign",campaignId:id,...(back?{returnTo:back}:{})});
}
test("requires an owned campaign and rejects external returns", async ({page}) => {
  const {writes,reads} = await setup(page);
  for(const id of ["","bad",foreign]) {
    await page.goto(url(id,"//untrusted.invalid"));
    await expect(page.getByRole("combobox",{name:"Campaign",exact:true})).toHaveValue("");
    await expect(page.getByRole("button",{name:"Save story behavior"})).toHaveCount(0);
    await expect(page.getByRole("link",{name:"Return to Story"})).toHaveCount(0);
  }
  expect(reads.some(path=>path.includes(foreign))).toBe(false);
  expect(writes).toEqual([]);
});
for (const [size,width] of [["desktop",1440],["mobile",390]] as const) {
  test(`${mode} campaign settings parity at ${size}`, async ({page}) => {
    await page.setViewportSize({width,height:900});
    const {writes} = await setup(page);
    await page.goto(url(a,"/app/story/"+a+"?turn=2"));
    await expect(page.getByRole("link",{name:"Return to Story"})).toHaveAttribute("href","/app/story/"+a+"?turn=2");
    await expect(page.getByLabel("Response length")).toBeVisible();
    await expect(page.getByRole("combobox",{name:"Memory level",exact:true}).locator('option[value=enhanced]')).toHaveJSProperty('disabled',true);
    await page.getByLabel("Response length").selectOption("brief");
    await page.getByRole("button",{name:"Save story behavior"}).click();
    await expect.poll(()=>writes.length).toBe(1);
    expect(writes[0]).toEqual({path:"/campaigns/"+a,body:{storyLengthProfile:"brief"}});
    await expect(page.getByLabel("Art style",{exact:true})).toHaveValue("A ink");
    await expect(page.getByLabel("Production implementation")).toBeVisible();
    await expect(page.getByRole("link",{name:"Characters",exact:true}).last()).toBeVisible();
    await expect(page.locator('button[data-action="rebuild-images"],#narration-correction-form,input[name=displayName]')).toHaveCount(0);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({path:`test-results/review-assets/settings-panel/${mode}-campaign-${size}.png`,fullPage:true});
  });
}
test("switching during a load or save ignores delayed old responses and preserves the new campaign", async ({page}) => {
  const {writes} = await setup(page);
  let delayedLoad!: () => void;
  let delayedSave!: () => void;
  let saving = false;
  let loading = false;
  await page.route("**/campaigns/"+a+"/illustration-config", async route => {
    loading = true;
    await new Promise<void>(resolve => {delayedLoad=resolve;});
    await route.fulfill({json:{...fixture.illustrationConfig,artStyle:"Old late response"}}).catch(()=>undefined);
  });
  await page.route("**/campaigns/"+a+"/story-memory",async route=>{
    if(route.request().method()==="GET") return route.fallback();
    saving=true;
    await new Promise<void>(resolve=>{delayedSave=resolve;});
    await route.fulfill({json:{...level,level:"max",reviewMode:"enforce"}}).catch(()=>undefined);
  });
  await page.goto(url(a));
  const select=page.getByRole("combobox",{name:"Campaign",exact:true});
  await expect.poll(()=>loading).toBe(true);
  await page.getByRole("combobox",{name:"Memory level",exact:true}).selectOption("max");
  page.once("dialog",d=>d.dismiss());
  await select.selectOption(b);
  await expect(select).toHaveValue(a);
  await page.getByRole("button",{name:"Save memory level"}).click();
  await expect.poll(()=>saving).toBe(true);
  page.once("dialog",d=>d.accept());
  await select.selectOption(b);
  await expect(page.getByLabel("Art style",{exact:true})).toHaveValue("B watercolor");
  delayedLoad(); delayedSave();
  await expect(page.getByRole("combobox",{name:"Memory level",exact:true})).toHaveValue("standard");
  await page.getByLabel("Art style",{exact:true}).fill("New ink");
  await page.getByRole("button",{name:"Save illustration settings"}).click();
  await expect.poll(()=>writes.length).toBe(1);
  expect(writes[0]).toMatchObject({path:"/campaigns/"+b+"/illustration-config",body:{artStyle:"New ink",refinementPrompt:fixture.illustrationConfig.refinementPrompt,negativePrompt:fixture.illustrationConfig.negativePrompt}});
  await page.evaluate(()=>window.dispatchEvent(new Event("app-identity-changed")));
  await expect(page.getByLabel("Art style",{exact:true})).toHaveCount(0);
});
test("keeps inherited assignments distinct from explicit campaign choices and exposes scoped model inventory", async ({page}) => {
  const {writes} = await setup(page);
  const textId = "44444444-4444-4444-8444-444444444444";
  const imageId = "55555555-5555-4555-8555-555555555555";
  const secondImage = "66666666-6666-4666-8666-666666666666";
  await page.route("**/api/v1/providers",route=>route.fulfill({json:{providers:[
    {...profileRow,id:textId,name:"House text",providerRole:"text"}, {...profileRow,id:imageId,name:"House image",providerRole:"image"}, {...profileRow,id:secondImage,isDefault:false,name:"Segment art",providerRole:"image"}
  ]}}));
  let inventories=0;
  await page.route("**/providers/"+imageId+"/models*",route=>{inventories++;return route.fulfill({json:{models:[{id:"image-model",displayName:"Image model"}]}});});
  await page.goto(url(a));
  const provider=page.getByRole("combobox",{name:"Text provider assignment",exact:true});
  await expect(provider).toHaveValue("");
  await expect(provider.locator("option:checked")).toContainText("House text");
  await provider.selectOption(textId);
  await page.getByRole("button",{name:"Save provider assignments"}).click();
  await expect.poll(()=>writes.length).toBe(1);
  await provider.selectOption("");
  await page.getByRole("button",{name:"Save provider assignments"}).click();
  await expect.poll(()=>writes.length).toBe(2);
  expect(writes.map(item=>item.body)).toEqual([{textProviderProfileId:textId},{textProviderProfileId:null}]);
  expect(inventories).toBe(0);
  await page.getByRole("button",{name:"Load image models"}).click();
  await expect.poll(()=>inventories).toBe(1);
  await expect(page.locator("datalist option[value=image-model]")).toHaveCount(1);
  const segment = page.getByRole("combobox",{name:"Segment image provider",exact:true});
  await segment.selectOption(secondImage);
  await page.getByRole("button",{name:"Save illustration settings"}).click();
  await expect.poll(()=>writes.length).toBe(3);
  const assignment = page.getByRole("combobox",{name:"Image provider assignment",exact:true});
  await expect(assignment).toHaveValue("");
  await assignment.selectOption(imageId);
  await page.getByRole("button",{name:"Save provider assignments"}).click();
  await expect.poll(()=>writes.length).toBe(4);
  expect(writes[2]).toMatchObject({path:"/campaigns/"+a+"/illustration-config",body:{providerProfileId:secondImage}});
  expect(writes[2]!.body).not.toHaveProperty("imageProviderProfileId");
  expect(writes[3]).toEqual({path:"/campaigns/"+a,body:{imageProviderProfileId:imageId}});
  await expect(segment).toHaveValue(secondImage);
  await segment.selectOption("");
  await page.getByRole("combobox",{name:"Automatic source",exact:true}).selectOption("generate_only");
  await page.getByRole("button",{name:"Save illustration settings"}).click();
  await expect(page.getByRole("status").filter({hasText:"Choose a segment image provider"})).toBeVisible();
  expect(writes).toHaveLength(4);
});
test("retains denied drafts and keeps the next campaign usable",async({page})=>{
  const {writes} = await setup(page);
  await page.route("**/campaigns/"+a+"/illustration-config",route=>route.request().method()==="PUT"
    ? route.fulfill({status:403,json:{message:"Permission denied"}}) : route.fallback());
  await page.goto(url(a));
  await page.getByLabel("Art style",{exact:true}).fill("Denied draft");
  await page.getByRole("button",{name:"Save illustration settings"}).click();
  await expect(page.getByRole("status").filter({hasText:"Permission denied"})).toBeVisible();
  await expect(page.getByLabel("Art style",{exact:true})).toHaveValue("Denied draft");
  page.once("dialog",dialog=>dialog.accept());
  await page.getByRole("combobox",{name:"Campaign",exact:true}).selectOption(b);
  await expect(page.getByLabel("Art style",{exact:true})).toHaveValue("B watercolor");
  expect(writes).toEqual([]);
});

test("campaign management routes retain operations and direct full configuration to Settings",async({page})=>{
  await setup(page);
  for(const [section,operation,removed] of [
    ["overview","#overview-form input[name=title]","#overview-form select[name=turnControlStyle]"],
    ["chronicle","[data-action=rebuild-memory]","#chronicle-form select[name=enabled]"],
    ["illustrations","[data-action=backfill-images]","#illustrations-form input[name=artStyle]"]
  ]) {
    await page.goto(base+"/app/campaigns/"+a+"/"+section);
    await expect(page.locator(operation!)).toBeVisible();
    await expect(page.locator(removed!)).toHaveCount(0);
    await expect(page.locator("#campaign-section a[data-campaign-settings-group]")).toHaveAttribute("href",new RegExp("section=campaign.*campaignId="+a));
  }
});

test("fences changes to the original turn style, turn number and state revision and preserves a conflicted draft",async({page})=>{
  const {writes} = await setup(page);
  await page.goto(url(a));
  const style = page.getByRole("combobox",{name:"Turn input style",exact:true});
  await style.selectOption("flexible_scene");
  await page.getByRole("button",{name:"Save story behavior"}).click();
  await expect.poll(()=>writes.length).toBe(1);
  expect(writes[0]?.body).toEqual({turnControlStyle:"flexible_scene",expectedTurnControlStyle:"action_only",expectedActiveTurnNumber:1,expectedStateRevision:4});
  await page.route("**/campaigns/"+a,route=>route.fulfill({status:409,json:{message:"Campaign changed."}}));
  await style.selectOption("flexible_action");
  await page.getByRole("button",{name:"Save story behavior"}).click();
  await expect(page.getByRole("status").filter({hasText:"Campaign changed"})).toBeVisible();
  await expect(style).toHaveValue("flexible_action");
});

test("saves Chronicle retrieval independently and reports the queued indexing job", async ({page}) => {
  const {writes} = await setup(page);
  let saved: unknown;
  await page.route("**/campaigns/"+a+"/memory/embedding-config", async route => {
    if (route.request().method() === "GET") return route.fallback();
    saved = route.request().postDataJSON();
    return route.fulfill({json:{jobId: "22222222-2222-4222-8222-222222222233"}});
  });
  await page.goto(url(a));
  await page.getByLabel("Query prefix").fill("question:");
  await page.getByLabel("Production implementation").selectOption("chunked_hybrid");
  await page.getByRole("button",{name:"Save & index"}).click();
  await expect(page.getByRole("status").filter({hasText:"Indexing queued"})).toBeVisible();
  expect(saved).toMatchObject({queryPrefix:"question:",retrievalImplementation:"chunked_hybrid",model:"fixture",enabled:false});
  expect(writes).toEqual([]);
  await expect(page.getByRole("link",{name:"Chronicle indexing and context preview"})).toHaveAttribute("href","/app/campaigns/"+a+"/chronicle");
});

test("returning to A reloads a committed save whose response was delayed during A to B", async ({page}) => {
  await setup(page);
  let length = rows[0]!.storyLengthProfile;
  let committed = false;
  let release!: () => void;
  await page.route("**/api/v1/campaigns", route => route.fulfill({json:{campaigns:[{...rows[0],storyLengthProfile:length},rows[1]]}}));
  await page.route("**/api/v1/campaigns/"+a, async route => {
    length = route.request().postDataJSON().storyLengthProfile;
    committed = true;
    await new Promise<void>(resolve => {release=resolve;});
    await route.fulfill({json:{...rows[0],storyLengthProfile:length}}).catch(()=>undefined);
  });
  await page.goto(url(a));
  const picker = page.getByRole("combobox",{name:"Campaign",exact:true});
  await page.getByLabel("Response length").selectOption("extended");
  await page.getByRole("button",{name:"Save story behavior"}).click();
  await expect.poll(()=>committed).toBe(true);
  page.once("dialog",dialog=>dialog.accept());
  await picker.selectOption(b);
  await expect(page.getByLabel("Art style",{exact:true})).toHaveValue("B watercolor");
  await picker.selectOption(a);
  release();
  await expect(page.getByLabel("Response length")).toHaveValue("extended");
  await expect(page.getByRole("button",{name:"Save story behavior"})).toBeDisabled();
});

test("assignment saves refresh inherited provider options, image counts and inventories while retaining section drafts", async ({page})=>{
  const {writes} = await setup(page);
  const img1 = "44444444-4444-4444-8444-444444444440";
  const img2 = "44444444-4444-4444-8444-444444444441";
  const txt1 = "44444444-4444-4444-8444-444444444442";
  const txt2 = "44444444-4444-4444-8444-444444444443";
  const profiles = [[img1,"image",2],[img2,"image",1],[txt1,"text",1],[txt2,"text",1]] as const;
  await page.route("**/api/v1/providers",route=>route.fulfill({json:{providers:profiles.map(([id,providerRole,count])=>({
    ...profileRow,id,providerRole,name:id,isDefault:id === txt1,configuration:{defaultImageCount:count}
  }))}}));
  await page.route("**/api/v1/campaigns/"+a+"/illustration-config",route=>route.request().method() === "GET"
    ? route.fulfill({json:{...fixture.illustrationConfig,updatedAt:null,providerProfileId:null,imagesPerSegment:1}}) : route.fallback());
  await page.route("**/api/v1/providers/*/models*",route=>route.fulfill({json:{models:[{id:"old-model",displayName:"Old model"}]}}));
  await page.goto(url(a));
  const images = page.getByLabel("Image provider assignment");
  const text = page.getByLabel("Text provider assignment");
  const save = page.getByRole("button",{name:"Save provider assignments"});
  const inventory = page.getByRole("button",{name:"Load image models"});
  const count = page.getByLabel("Images per segment");
  const embedding = page.getByLabel("Embedding provider");
  await expect(inventory).toBeDisabled();
  await expect(embedding).toHaveValue(txt1);
  await page.getByLabel("Art style",{exact:true}).fill("Draft ink");
  await page.getByLabel("Query prefix").fill("Draft query");
  await images.selectOption(img1);
  await text.selectOption(txt2);
  await save.click();
  await expect(inventory).toBeEnabled();
  await expect(count).toHaveValue("2");
  await expect(embedding).toHaveValue(txt2);
  await expect(page.getByLabel("Query prefix")).toHaveValue("Draft query");
  await expect(page.getByLabel("Art style",{exact:true})).toHaveValue("Draft ink");
  await inventory.click();
  await expect(page.locator("#campaign-image-models option")).toHaveCount(1);
  await images.selectOption(img2);
  await save.click();
  await expect(page.locator("#campaign-image-models option")).toHaveCount(0);
  await expect(count).toHaveValue("1");
  await page.getByRole("button",{name:"Save illustration settings"}).click();
  await expect.poll(()=>writes.length).toBe(3);
  await images.selectOption(img1);
  await save.click();
  await expect(save).toBeDisabled();
  await expect(count).toHaveValue("1");
  await expect(page.getByRole("button",{name:"Save illustration settings"})).toBeDisabled();
});

test("initial missing segment configuration uses the owner's image count while a saved count stays explicit",async({page})=>{
  await setup(page);
  const id = "44444444-4444-4444-8444-444444444440";
  await page.route("**/api/v1/providers",route=>route.fulfill({json:{providers:[{...profileRow,id,providerRole:"image",name:"Illustrations",configuration:{defaultImageCount:2}}]}}));
  await page.route("**/campaigns/"+a+"/illustration-config",route=>route.fulfill({json:{...fixture.illustrationConfig,updatedAt:null,providerProfileId:null,imagesPerSegment:1}}));
  await page.route("**/campaigns/"+b+"/illustration-config",route=>route.fulfill({json:{...fixture.illustrationConfig,providerProfileId:null,imagesPerSegment:1}}));
  await page.goto(url(a));
  await expect(page.getByLabel("Images per segment")).toHaveValue("2");
  await page.getByRole("combobox",{name:"Campaign",exact:true}).selectOption(b);
  await expect(page.getByLabel("Images per segment")).toHaveValue("1");
});

for (const source of ["segment", "campaign"] as const) {
  test(`unavailable explicit ${source} image profile cannot use another profile's inventory or initial count`, async ({page}) => {
    await setup(page);
    const unavailableId = "44444444-4444-4444-8444-444444444440";
    const defaultId = "44444444-4444-4444-8444-444444444441";
    await page.route("**/api/v1/providers", route => route.fulfill({json:{providers:[
      {...profileRow, id:unavailableId, name:"Retired image profile", providerRole:"image", enabled:false, isDefault:false},
      {...profileRow, id:defaultId, name:"Owner default", providerRole:"image", configuration:{defaultImageCount:2}}
    ]}}));
    await page.route("**/api/v1/campaigns", route => route.fulfill({json:{campaigns:[
      {...rows[0],imageProviderProfileId:source === "campaign" ? unavailableId : defaultId}
    ]}}));
    await page.route("**/campaigns/"+a+"/illustration-config", route => route.fulfill({json:{
      ...fixture.illustrationConfig, providerProfileId:source === "segment" ? unavailableId : null,
      updatedAt:source === "segment" ? fixture.illustrationConfig.updatedAt : null, imagesPerSegment:1
    }}));
    const requested: string[] = [];
    await page.route("**/api/v1/providers/*/models*", route => {
      requested.push(new URL(route.request().url()).pathname);
      return route.fulfill({json:{models:[{id:"owner-model",displayName:"Owner model"}]}});
    });
    await page.goto(url(a));
    const selected = page.getByLabel(source === "segment" ? "Segment image provider" : "Image provider assignment");
    await expect(selected.locator("option:checked")).toContainText("unavailable");
    const inventory = page.getByRole("button",{name:"Load image models"});
    await expect(inventory).toBeVisible();
    if (await inventory.isEnabled()) await inventory.click();
    await expect(inventory).toBeDisabled();
    expect(requested).toEqual([]);
    await expect(page.getByLabel("Images per segment")).toHaveValue("1");

    await selected.selectOption("");
    if (source === "campaign") await page.getByRole("button",{name:"Save provider assignments"}).click();
    await expect(inventory).toBeEnabled();
    await expect(page.getByLabel("Images per segment")).toHaveValue(source === "segment" ? "1" : "2");
    await inventory.click();
    await expect(page.locator("#campaign-image-models option")).toHaveCount(1);
    expect(requested).toEqual(["/api/v1/providers/"+defaultId+"/models"]);
  });
}
