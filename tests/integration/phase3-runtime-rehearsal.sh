#!/bin/sh
# Run inside an ephemeral Linux container with /host (worktree) and /baseline.tar
# mounted read-only, /app's Linux node_modules, and a disposable local PostgreSQL.
set -eu
cd /app
suffix="$(node -e 'process.stdout.write(require("crypto").randomBytes(8).toString("hex"))')"
source_db="phase3_boot_base_$suffix"
current_db="phase3_boot_current_$suffix"
restored_db="phase3_boot_restore_$suffix"
admin_url="postgresql://infinitequest_test:${POSTGRES_PASSWORD}@127.0.0.1:5432/infinitequest_test"
export CREDENTIAL_ENCRYPTION_KEY='phase3-disposable-fixture-key-32-bytes' APP_HOST=127.0.0.1 APP_PORT=45431
export CAST_PRESETS_ENABLED=false CAST_CONTEXT_WITHOUT_DISCOVERY_ENABLED=false CAST_DISCOVERY_ENABLED=false
export DATABASE_MAX_CONNECTIONS=12 MIGRATION_DIRECTORY=/app/database/migrations
mkdir -p /tmp/phase3-web-legacy /tmp/phase3-web-next /tmp/phase3-assets /tmp/phase3-archives
export LEGACY_WEB_ROOT=/tmp/phase3-web-legacy NEXT_WEB_ROOT=/tmp/phase3-web-next
export ASSET_STORAGE_ROOT=/tmp/phase3-assets ARCHIVE_STORAGE_ROOT=/tmp/phase3-archives
api_pid='' worker_pid=''
cleanup() {
  [ -z "$api_pid" ] || kill "$api_pid" 2>/dev/null || true
  [ -z "$worker_pid" ] || kill "$worker_pid" 2>/dev/null || true
  [ -z "$api_pid" ] || wait "$api_pid" 2>/dev/null || true
  [ -z "$worker_pid" ] || wait "$worker_pid" 2>/dev/null || true
  ADMIN_URL="$admin_url" SOURCE_DB="$source_db" CURRENT_DB="$current_db" RESTORED_DB="$restored_db" node --input-type=module -e '
    import pg from "pg"; const c=new pg.Client({connectionString:process.env.ADMIN_URL}); await c.connect();
    for(const n of [process.env.CURRENT_DB,process.env.RESTORED_DB,process.env.SOURCE_DB]) {
      if(!/^phase3_boot_(base|current|restore)_[a-f0-9]{16}$/.test(n)) throw Error("invalid database name");
      await c.query(`DROP DATABASE IF EXISTS ${n} WITH (FORCE)`);
    } await c.end();' || true
}
trap cleanup EXIT INT TERM
ADMIN_URL="$admin_url" SOURCE_DB="$source_db" node --input-type=module -e '
  import pg from "pg"; const c=new pg.Client({connectionString:process.env.ADMIN_URL}); await c.connect();
  const n=process.env.SOURCE_DB; if(!/^phase3_boot_base_[a-f0-9]{16}$/.test(n)) throw Error("invalid database name");
  await c.query(`CREATE DATABASE ${n}`); await c.end();'
load_old() {
  rm -rf /app/packages /app/services /app/database /app/apps
  tar -C /app -xf /baseline.tar
  pnpm install --frozen-lockfile >/tmp/phase3-old-install.log 2>&1 || { tail -40 /tmp/phase3-old-install.log; exit 1; }
}
load_new() {
  rm -rf /app/packages /app/services /app/database /app/apps
  tar -C /host --exclude=./node_modules --exclude=./.git --exclude=./test-results --exclude=./phase3-baseline-rehearsal.tar -cf - . | tar -C /app -xf -
  pnpm install --frozen-lockfile >/tmp/phase3-new-install.log 2>&1 || { tail -40 /tmp/phase3-new-install.log; exit 1; }
}
load_old
export DATABASE_URL="postgresql://infinitequest_test:${POSTGRES_PASSWORD}@127.0.0.1:5432/$source_db"
APP_ROLE=migrate node_modules/.bin/tsx services/runtime/src/main.ts >/tmp/phase3-old-migrate.log 2>&1 || { tail -60 /tmp/phase3-old-migrate.log; exit 1; }
node --input-type=module -e '
  import pg from "pg"; const c=new pg.Client({connectionString:process.env.DATABASE_URL}); await c.connect();
  const u=(await c.query("SELECT id FROM users WHERE system_key=$1",["initial-owner"])).rows[0].id;
  const w=(await c.query("INSERT INTO worlds(owner_user_id,title) VALUES($1,$2) RETURNING id",[u,"Phase 3 boot fixture"])).rows[0].id;
  await c.query("INSERT INTO world_versions(world_id,owner_user_id,version_number,content) VALUES($1,$2,1,$3)",[w,u,{schemaVersion:6,world:{title:"Phase 3 boot fixture",genre:"Fantasy",tone:"Hopeful",premise:"A guide waits.",backgroundStory:"A quiet road.",firstAction:"Begin.",rules:""},playableCharacters:[{id:"hero",name:"Hero",characterText:"A guide",rpgStats:[],defaultTriggers:[],source:{}}],entities:[],relationships:[],rpgStats:[],defaultTriggers:[],eventTriggers:[],assets:[],defaults:{}}]);
  await c.end();'
ADMIN_URL="$admin_url" SOURCE_DB="$source_db" CURRENT_DB="$current_db" RESTORED_DB="$restored_db" node --input-type=module -e '
  import pg from "pg"; const c=new pg.Client({connectionString:process.env.ADMIN_URL}); await c.connect();
  for(const n of [process.env.CURRENT_DB,process.env.RESTORED_DB]) {
    if(!/^phase3_boot_(current|restore)_[a-f0-9]{16}$/.test(n) || !/^phase3_boot_base_[a-f0-9]{16}$/.test(process.env.SOURCE_DB)) throw Error("invalid database name");
    await c.query(`CREATE DATABASE ${n} TEMPLATE ${process.env.SOURCE_DB}`);
  } await c.end();'
boot_and_read() {
  label="$1"
  APP_ROLE=api node_modules/.bin/tsx services/runtime/src/main.ts >"/tmp/phase3-$label-api.log" 2>&1 & api_pid=$!
  APP_ROLE=worker node_modules/.bin/tsx services/runtime/src/main.ts >"/tmp/phase3-$label-worker.log" 2>&1 & worker_pid=$!
  if ! LABEL="$label" node --input-type=module -e '
    let ready=false; for(let i=0;i<120;i++){try{const r=await fetch("http://127.0.0.1:45431/health/ready");if(r.ok){ready=true;break}}catch{} await new Promise(r=>setTimeout(r,250));}
    if(!ready) throw Error("API readiness timeout");
    const meta=await (await fetch("http://127.0.0.1:45431/api/v1/meta")).json();
    const worlds=await (await fetch("http://127.0.0.1:45431/api/v1/worlds")).json();
    if(!JSON.stringify(worlds).includes("Phase 3 boot fixture")) throw Error("old world unavailable");
    if(process.env.LABEL==="current" && meta.capabilities.castPresets !== false) throw Error("presets unexpectedly enabled");
    console.log(JSON.stringify({phase:process.env.LABEL,ready:true,oldWorldReadable:true,metadata:meta.application,capabilities:meta.capabilities}));'; then
    tail -80 "/tmp/phase3-$label-api.log"; tail -80 "/tmp/phase3-$label-worker.log"; exit 1
  fi
  count=0
  until grep -q 'runtime_settings_active' "/tmp/phase3-$label-worker.log" && grep -q 'worker_started' "/tmp/phase3-$label-worker.log"; do
    count=$((count+1)); if [ "$count" -gt 120 ] || ! kill -0 "$worker_pid" 2>/dev/null; then tail -80 "/tmp/phase3-$label-worker.log"; exit 1; fi
    sleep .25
  done
  echo "$label worker settings active and started"
  kill "$api_pid" "$worker_pid"; wait "$api_pid" || true; wait "$worker_pid" || true; api_pid=''; worker_pid=''
}
load_new
export DATABASE_URL="postgresql://infinitequest_test:${POSTGRES_PASSWORD}@127.0.0.1:5432/$current_db"
APP_ROLE=migrate node_modules/.bin/tsx services/runtime/src/main.ts >/tmp/phase3-new-migrate.log 2>&1 || { tail -60 /tmp/phase3-new-migrate.log; exit 1; }
boot_and_read current
load_old
export DATABASE_URL="postgresql://infinitequest_test:${POSTGRES_PASSWORD}@127.0.0.1:5432/$restored_db"
boot_and_read restored
