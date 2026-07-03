/**
 * Lua harness injected at the END of a cart's __lua__ section.
 *
 * Protocol (validated by spike on PICO-8 0.2.7 Linux):
 * - PICO-8's serial(0x804, addr, len) has fread semantics: it BLOCKS until
 *   exactly `len` bytes arrived on stdin (or EOF). So the driver speaks in
 *   fixed-size 8-byte packets: <op:1><a:3 hex><b:3 hex>\n
 *   Optional variable payloads follow the header; their length is in `a`.
 * - While blocked, the engine is frozen => perfect lockstep, and batched
 *   frames run at host speed (measured ~600 game frames in <30ms).
 * - Replies go to stdout via printh (text lines prefixed with "@") and
 *   serial(0x805, ...) for raw binary blocks (framebuffer, memory).
 *
 * Commands:
 *   f <mask> <frames>  hold buttons = mask, run <frames> game updates, ack "@f <frame>"
 *                      (ack is emitted at the top of the NEXT engine update,
 *                       i.e. after _draw ran => screenshots are always fresh)
 *   s                  dump 64 bytes of palette state (0x5f00..0x5f3f) +
 *                      8192 bytes of framebuffer (0x6000..0x7fff)
 *   g <len>            payload: comma-separated dotted global names;
 *                      replies "@vs <n>" then n lines "@v <i> <value>"
 *   p <len>            payload: "<addr>,<len>" decimal; replies "@m <len>" + raw bytes
 *   q                  extcmd("shutdown")
 *
 * All harness globals are prefixed _hz to avoid collisions.
 */

export const HARNESS_MARKER = "-- pico8-mcp harness --";

export function harnessLua(seed?: number): string {
  const srand = seed !== undefined ? `srand(${seed})\n` : "";
  return `
${HARNESS_MARKER}
${srand}_hzb={} _hztp={} _hzpv={}
function btn(i,p)
 if p~=nil and p>0 then if i==nil then return 0 end return false end
 if i==nil then
  local m=0
  for k=0,5 do if _hzb[k] then m=m|(1<<k) end end
  return m
 end
 return _hzb[i]==true
end
function btnp(i,p)
 if p~=nil and p>0 then if i==nil then return 0 end return false end
 if i==nil then
  local m=0
  for k=0,5 do if _hztp[k] then m=m|(1<<k) end end
  return m
 end
 return _hztp[i]==true
end
function _hzhx(a,n)
 local v=0
 for i=0,n-1 do
  local c=peek(a+i)
  if c>=97 then c-=87 elseif c>=65 then c-=55 else c-=48 end
  v=v*16+c
 end
 return v
end
function _hzdie()
 extcmd("shutdown")
end
function _hzrds(len)
 local s=""
 while #s<len do
  local c=min(96,len-#s)
  local n=serial(0x804,0x5f80,c)
  if n<c then _hzdie() return s end
  for i=0,n-1 do s=s..chr(peek(0x5f80+i)) end
 end
 return s
end
function _hzget(path)
 local v=_ENV
 local segs=split(path,".")
 for i=1,#segs do
  if type(v)~="table" then return nil end
  local k=tonum(segs[i])
  if k==nil then k=segs[i] end
  v=v[k]
 end
 return v
end
function _hzesc(s)
 local r=""
 for i=1,#s do
  local c=ord(s,i)
  if c==10 then r=r.."\\n" elseif c==13 then r=r.."\\r" else r=r..chr(c) end
 end
 return r
end
function _hzser(v,deep)
 local t=type(v)
 if t=="table" then
  if not deep then return "<table>" end
  local s="{"
  local n=0
  for k,val in pairs(v) do
   n+=1
   if n>32 then s=s.."<more>" break end
   s=s..tostr(k).."=".._hzser(val,false).." "
  end
  return s.."}"
 elseif t=="string" then
  return _hzesc(v)
 elseif t=="function" then
  return "<function>"
 else
  return tostr(v)
 end
end
_hzfr=0 _hzboot=0 _hzack=false
function _hzloop()
 if _hzboot==0 then _hzboot=1 printh("@rdy ".._hzhz) _hzack=true return end
 if _hzack then printh("@f ".._hzfr) _hzack=false end
 while true do
  local n=serial(0x804,0x5f80,8)
  if n<8 then _hzdie() return end
  local op=chr(peek(0x5f80))
  local a=_hzhx(0x5f81,3)
  local b=_hzhx(0x5f84,3)
  if op=="f" then
   for i=0,5 do _hzb[i]=((a>>i)&1)==1 end
   for k=1,b do
    for i=0,5 do _hztp[i]=_hzb[i] and not _hzpv[i] _hzpv[i]=_hzb[i] end
    _hzfr+=1
    _hzu()
   end
   _hzack=true
   return
  elseif op=="s" then
   printh("@fb 8256")
   serial(0x805,0x5f00,0x40)
   serial(0x805,0x6000,0x2000)
   printh("@fbend")
  elseif op=="g" then
   local raw=_hzrds(a)
   local names=split(raw,",")
   printh("@vs "..#names)
   for i=1,#names do
    printh("@v "..i.." ".._hzser(_hzget(names[i]),true))
   end
  elseif op=="p" then
   local pl=split(_hzrds(a),",")
   local ad=tonum(pl[1]) or 0
   local ln=tonum(pl[2]) or 0
   printh("@m "..ln)
   if ln>0 then serial(0x805,ad,ln) end
   printh("@mend")
  elseif op=="q" then
   _hzdie()
   return
  end
 end
end
if _update60~=nil then
 _hzu=_update60 _hzhz=60 _update60=_hzloop
elseif _update~=nil then
 _hzu=_update _hzhz=30 _update=_hzloop
else
 _hzu=function() end _hzhz=30 _update=_hzloop
end
`;
}

const SECTION_RE = /^__(gfx|gff|label|map|sfx|music|change_mask|meta:.*)__\s*$/;

/**
 * Inject the harness at the end of the __lua__ section of a .p8 cart.
 * Throws if the cart has no __lua__ section.
 */
export function injectHarness(cartText: string, seed?: number): string {
  const lines = cartText.split(/\r?\n/);
  const luaStart = lines.findIndex((l) => l.trim() === "__lua__");
  if (luaStart < 0) throw new Error("not a .p8 text cart: missing __lua__ section");
  let luaEnd = lines.length;
  for (let i = luaStart + 1; i < lines.length; i++) {
    if (SECTION_RE.test(lines[i].trim())) {
      luaEnd = i;
      break;
    }
  }
  const harness = harnessLua(seed).split("\n");
  const out = [...lines.slice(0, luaEnd), ...harness, ...lines.slice(luaEnd)];
  return out.join("\n");
}
