param([string]$Emsdk = $env:EMSDK)
$ErrorActionPreference = "Stop"
$repoRoot = Split-Path $PSScriptRoot -Parent
Set-Location -LiteralPath $repoRoot
if (!$Emsdk) { throw "Set EMSDK or pass -Emsdk with an activated Emscripten SDK directory." }
$sdkRoot = (Resolve-Path -LiteralPath $Emsdk).Path
$env:EM_CONFIG = Join-Path $sdkRoot ".emscripten"
$env:EM_CACHE = Join-Path $sdkRoot "upstream/emscripten/cache"
foreach ($arenaCap in @(32)) {
python (Join-Path $sdkRoot "upstream/emscripten/em++.py") vendor/usearch/source/c/lib.cpp vendor/usearch/wrapper.cpp -Ivendor/usearch -Ivendor/usearch/source/include "-DVECTOR_ARENA_CAP_MIB=$arenaCap" -O3 -std=c++17 -DNDEBUG -DUSEARCH_USE_NUMKONG=0 -DUSEARCH_USE_OPENMP=0 -msimd128 -fexceptions -sMODULARIZE=1 -sEXPORT_ES6=1 '-sENVIRONMENT=web,worker' -sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=2147483648 '-sEXPORTED_FUNCTIONS=["_ul_filtered_search","_ul_save_slice","_ul_load_js","_ul_validate_identity","_ul_arena_cap","_ul_stat","_ul_allocator_probe","_malloc","_free","_ul_open","_ul_reserve","_ul_add","_ul_remove","_ul_search","_ul_key","_ul_distance","_ul_snapshot_metric","_ul_count","_ul_memory","_ul_size","_ul_save","_ul_load","_ul_snapshot_scalar","_ul_version","_ul_acceleration","_ul_error","_ul_close"]' '-sEXPORTED_RUNTIME_METHODS=["HEAPU8","ccall","UTF8ToString"]' -o "addon/content/vector/usearch.mjs"
if ($LASTEXITCODE -ne 0) { throw "USearch WASM compilation failed" }


}
node scripts/check-usearch.mjs --write
if ($LASTEXITCODE -ne 0) { throw "USearch provenance generation failed" }
