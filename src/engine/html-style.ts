// The stylesheet of the run page. Tokens and component shapes come from the Swiss pattern library
// (01-pattern-library.html in the abagile folder). No colours are added beyond its tokens.
export const CSS = `
  :root {
    --paper:#FFFFFF; --ground:#F3F3F0; --ink:#0A0A0A; --ink-2:#363636; --ink-3:#686866;
    --rule:#0A0A0A; --hair:#D6D6D0; --red:#E3000F; --red-ink:#FFFFFF;
    --c1:#0050C8; --c2:#A35F00; --c3:#007A4D; --c4:#B4237A; --c5:#5A3FC0; --muted:#9A9A94;
    --wash-red:#FDECEC; --wash-blue:#EAF0FB; --wash-green:#E7F4EE;
    --sans:"Inter Tight","Helvetica Neue",Helvetica,Arial,"PingFang TC","Noto Sans TC",sans-serif;
    --mono:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
    /* motion tokens */
    --t-fast:160ms; --t-base:320ms; --t-slow:640ms; --t-draw:900ms;
    --ease-out:cubic-bezier(.2,.7,.2,1); --ease-in-out:cubic-bezier(.65,0,.35,1);
    --ease-snap:cubic-bezier(.3,1.4,.5,1);
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --paper:#141414; --ground:#0A0A0A; --ink:#F5F5F2; --ink-2:#CACAC4; --ink-3:#92928C;
      --rule:#F5F5F2; --hair:#2E2E2C; --red:#FF4136; --red-ink:#0A0A0A;
      --c1:#5B9BFF; --c2:#F0B13C; --c3:#3FD08F; --c4:#F07AC0; --c5:#A993FF; --muted:#6A6A66;
      --wash-red:#2A1213; --wash-blue:#0F1B2E; --wash-green:#0E2219;
    }
  }
  :root[data-theme="dark"] {
    --paper:#141414; --ground:#0A0A0A; --ink:#F5F5F2; --ink-2:#CACAC4; --ink-3:#92928C;
    --rule:#F5F5F2; --hair:#2E2E2C; --red:#FF4136; --red-ink:#0A0A0A;
    --c1:#5B9BFF; --c2:#F0B13C; --c3:#3FD08F; --c4:#F07AC0; --c5:#A993FF; --muted:#6A6A66;
    --wash-red:#2A1213; --wash-blue:#0F1B2E; --wash-green:#0E2219;
  }
  * { box-sizing:border-box; }
  [hidden] { display:none !important; }
  html { scroll-behavior:smooth; scroll-padding-top:72px; }
  body { margin:0; background:var(--ground); color:var(--ink); font-family:var(--sans); font-size:17px; line-height:1.55;
         -webkit-font-smoothing:antialiased; font-feature-settings:"ss01","tnum"; }
  p { margin:0; }
  h1,h2,h3,h4 { font-weight:700; letter-spacing:-.02em; }
  code { font-family:var(--mono); font-size:.84em; padding:1px 5px; background:var(--paper); border:1px solid var(--hair); overflow-wrap:anywhere; }
  a { color:var(--ink); text-decoration-color:var(--red); text-decoration-thickness:2px; text-underline-offset:3px; }
  a:hover { color:var(--red); }
  a[target="_blank"]::after { content:" ↗"; color:var(--ink-3); font-size:.9em; }
  :focus-visible { outline:3px solid var(--red); outline-offset:2px; }
  summary { cursor:pointer; }
  button { font:inherit; }

  /* top bar: section index */
  .bar { position:sticky; top:0; z-index:50; background:var(--ground); border-bottom:1px solid var(--rule); }
  .bar-in { max-width:1240px; margin:0 auto; padding:0 24px; height:52px; display:flex; align-items:center; gap:20px; }
  .mark { display:flex; align-items:center; gap:10px; font-weight:800; letter-spacing:-.02em; font-size:15px; white-space:nowrap; }
  .mark i { width:14px; height:14px; background:var(--red); display:inline-block; }
  .bar nav { flex:1; overflow-x:auto; scrollbar-width:none; }
  .bar nav::-webkit-scrollbar { display:none; }
  .bar ol { margin:0; padding:0; list-style:none; display:flex; gap:2px; justify-content:flex-end; }
  .bar ol a { display:block; font-family:var(--mono); font-size:12px; padding:4px 8px; text-decoration:none; color:var(--ink-3); white-space:nowrap; }
  .bar ol a:hover { color:var(--ink); background:var(--paper); }
  .theme-btn { font-family:var(--mono); font-size:12px; padding:4px 12px; margin-left:12px; white-space:nowrap; cursor:pointer; color:var(--ink); background:var(--paper); border:1px solid var(--rule); border-radius:999px; }
  .theme-btn:hover { background:var(--ink); color:var(--ground); }

  .page { counter-reset:sec; max-width:1240px; margin:0 auto; padding:0 24px 120px; }

  /* masthead */
  .mast { display:grid; grid-template-columns:repeat(12,minmax(0,1fr)); column-gap:24px; row-gap:20px;
          padding:56px 0 40px; border-bottom:6px solid var(--rule); }
  .kicker { grid-column:1 / -1; font-family:var(--mono); font-size:12px; letter-spacing:.08em; text-transform:uppercase; color:var(--ink-3); }
  .kicker b { color:var(--red); font-weight:600; margin-left:10px; }
  .mast h1 { grid-column:1 / -1; margin:0; font-weight:800; letter-spacing:-.045em; line-height:.92; font-size:clamp(2.6rem,7vw,5.6rem); overflow-wrap:anywhere; }
  .mast h1.subject { font-size:clamp(1.5rem,3.4vw,2.5rem); line-height:1.12; letter-spacing:-.03em; font-weight:700; }
  .sq { display:inline-block; width:.5em; height:.5em; background:var(--red); margin-left:.06em; vertical-align:baseline; }
  .stand { grid-column:1 / 10; font-size:clamp(1.05rem,1.6vw,1.25rem); line-height:1.4; color:var(--ink-2); overflow-wrap:anywhere; }
  .meta { grid-column:1 / -1; margin:0; display:grid; grid-template-columns:repeat(auto-fit,minmax(170px,1fr)); gap:12px 24px;
          border-top:1px solid var(--rule); padding-top:14px; }
  .meta dt { font-family:var(--mono); font-size:11px; letter-spacing:.1em; text-transform:uppercase; color:var(--ink-3); }
  .meta dd { margin:2px 0 0; font-size:15px; font-weight:500; overflow-wrap:anywhere; }
  .mast > .figs { grid-column:1 / -1; }

  /* sections: numbered side column, content column */
  .sec { counter-increment:sec; display:grid; grid-template-columns:repeat(12,minmax(0,1fr)); column-gap:24px;
         padding:36px 0 56px; border-top:3px solid var(--rule); }
  .sec-side { grid-column:1 / 3; align-self:start; position:sticky; top:72px; display:flex; flex-direction:column; gap:8px; color:inherit; text-decoration:none; }
  .sec-no::before { content:counter(sec, decimal-leading-zero); font-weight:800; font-size:clamp(2.4rem,4vw,3.4rem); line-height:.85; letter-spacing:-.05em; }
  .sec-kind { font-family:var(--mono); font-size:12px; letter-spacing:.1em; text-transform:uppercase; color:var(--red); font-weight:600; }
  .sec-main { grid-column:3 / 13; min-width:0; display:flex; flex-direction:column; gap:22px; }
  .sec-main h2 { margin:0; font-size:clamp(1.7rem,3.4vw,2.6rem); line-height:1.05; letter-spacing:-.035em; }
  .lead { font-size:1.05rem; line-height:1.45; color:var(--ink-2); }
  .hint { font-size:13px; color:var(--ink-3); }

  /* headline callout; figures in it are highlighted as chips, so they read on light and dark */
  .rulebox { background:var(--ink); color:var(--ground); padding:24px 26px; display:flex; flex-direction:column; gap:10px; }
  .rulebox .k { font-family:var(--mono); font-size:11px; letter-spacing:.12em; text-transform:uppercase; color:var(--red); }
  .rulebox b { font-size:clamp(1.25rem,2.4vw,1.75rem); font-weight:700; letter-spacing:-.025em; line-height:1.3; }
  .rulebox .fig { color:var(--c3); }
  .fig { color:var(--c1); font-weight:700; white-space:nowrap; }

  /* figures: a bold label and a value; a row per group of related figures */
  .figs { display:grid; grid-template-columns:repeat(auto-fit,minmax(130px,1fr)); gap:10px 18px; }
  .fig-cell { display:flex; flex-direction:column; gap:4px; min-width:0; }
  .fig-cell .l { font-size:14px; font-weight:400; color:var(--ink); line-height:1.3; }
  .fig-cell .v { font-weight:800; font-size:1.5rem; line-height:1.05; letter-spacing:-.04em; white-space:nowrap; }
  .fig-cell .n { font-size:13px; color:var(--ink-2); line-height:1.35; overflow-wrap:anywhere; }
  .fig-cell.good .v { color:var(--c3); } .fig-cell.warn .v { color:var(--c2); }
  .fig-cell.bad .v { color:var(--red); } .fig-cell.info .v { color:var(--c1); }

  /* numbered points */
  .reasons { margin:0; padding:0; list-style:none; counter-reset:r; border-top:2px solid var(--rule); }
  .reasons > li { counter-increment:r; display:grid; grid-template-columns:52px 1fr; gap:4px 14px; padding:12px 0; border-bottom:1px solid var(--hair); color:var(--ink-2); font-size:15.5px; }
  .reasons > li::before { content:counter(r, decimal-leading-zero); grid-row:1 / 3; font-weight:800; font-size:1.4rem; line-height:1; letter-spacing:-.04em; color:var(--ink); }
  .reasons a { color:var(--ink); font-weight:600; text-decoration-color:var(--ink-3); text-decoration-thickness:1px; }
  .reasons a:hover { color:var(--red); text-decoration-color:var(--red); }
  .pt-group { display:flex; flex-direction:column; gap:8px; }
  .list-title { margin:0; font-family:var(--mono); font-size:11px; letter-spacing:.12em; text-transform:uppercase; color:var(--ink-3); font-weight:600; }
  .reasons .pt-text { grid-column:2; grid-row:1 / 3; align-self:start; }
  .pts { margin:4px 0 0; padding-left:1.1em; color:var(--ink-2); font-size:15px; }
  .pts > li { margin:3px 0; }
  .pts > li::marker { color:var(--red); }

  /* pills: statuses, metadata, filters */
  .pill { display:inline-flex; align-items:center; gap:4px; padding:1px 10px; border:1px solid var(--hair); border-radius:999px;
          font-family:var(--mono); font-size:12px; line-height:1.6; color:var(--ink-2); background:var(--paper); white-space:nowrap; max-width:100%; text-decoration:none; }
  .pill.tone-good { color:var(--c3); border-color:var(--c3); } .pill.tone-warn { color:var(--c2); border-color:var(--c2); }
  .pill.tone-bad { color:var(--red); border-color:var(--red); } .pill.tone-info { color:var(--c1); border-color:var(--c1); }
  .pill.tone-quiet { color:var(--ink-3); }
  .pill.id { color:var(--red); border-color:var(--red); font-weight:700; }
  button.pill { cursor:pointer; }
  button.pill:hover { background:var(--ink); color:var(--ground); border-color:var(--ink); }
  button.pill[aria-pressed="true"] { background:var(--ink); color:var(--ground); border-color:var(--ink); }
  .filters { display:flex; flex-wrap:wrap; gap:6px; align-items:center; }
  .filters .sep { width:1px; height:22px; background:var(--hair); margin:0 4px; }
  .filters .n { opacity:.7; margin-left:2px; }
  .count { font-family:var(--mono); font-size:12px; color:var(--ink-3); margin-left:auto; }

  /* boxes: rounded, with a coloured top bar (the job-tile of the infographic library) */
  .box { --c:var(--rule); background:var(--paper); border:1px solid var(--hair); border-top:5px solid var(--c); border-radius:12px; padding:16px 18px; }
  .accent-good { --c:var(--c3); } .accent-warn { --c:var(--c2); } .accent-bad { --c:var(--red); }
  .accent-info { --c:var(--c1); } .accent-quiet { --c:var(--hair); }
  .items { display:flex; flex-direction:column; gap:12px; }
  .item { display:flex; flex-direction:column; gap:10px; }
  .item h3 { margin:0; font-size:1.08rem; line-height:1.3; }
  .item-pills { display:flex; flex-wrap:wrap; gap:6px; align-items:center; }
  .item > summary { display:flex; flex-direction:column; gap:10px; padding-left:22px; position:relative; list-style:none; }
  .item > summary::-webkit-details-marker { display:none; }
  .item > summary::before { content:"▸"; position:absolute; left:0; top:0; color:var(--ink-3); }
  details.item[open] > summary::before { content:"▾"; }
  details.item[open] > summary { margin-bottom:2px; }
  .item .block { display:flex; flex-direction:column; gap:4px; }
  .item .block h4 { margin:0; font-family:var(--mono); font-size:11px; letter-spacing:.12em; text-transform:uppercase; color:var(--ink-3); font-weight:600; }
  .item .block p { font-size:15px; color:var(--ink-2); }
  .sites { margin:0; padding-left:1.1em; font-size:14px; }
  .attempts { margin:0; padding:0; list-style:none; display:flex; flex-direction:column; gap:10px; }
  .attempts > li { border-left:3px solid var(--hair); padding:4px 0 4px 12px; font-size:14.5px; display:flex; flex-direction:column; gap:4px; }
  .attempts .a-head { display:flex; flex-wrap:wrap; gap:6px; align-items:center; }
  .layer { background:var(--paper); border:1px solid var(--hair); border-radius:12px; padding:10px 14px; }
  .layer > summary { font-weight:600; font-size:14.5px; }
  .f-body { display:flex; flex-direction:column; gap:12px; border-top:1px solid var(--hair); margin-top:10px; padding-top:10px; }
  .layer > .f-body { border-top:1px solid var(--hair); margin-top:10px; padding-top:10px; display:flex; flex-direction:column; gap:12px; }

  /* rounds */
  .round .links { margin:10px 0 2px; padding-left:1.2em; display:flex; flex-direction:column; gap:6px; font-size:14.5px; color:var(--ink-2); }
  .round .links li b { color:var(--ink); font-weight:600; }
  .items-sub { margin:4px 0 0; padding-left:1.2em; display:flex; flex-direction:column; gap:3px; color:var(--ink-2); }
  .round > summary { font-weight:600; font-size:15.5px; display:flex; flex-wrap:wrap; gap:6px 12px; align-items:center; }

  /* tables */
  .scroll { overflow-x:auto; margin-top:24px; }
  table.t { width:100%; border-collapse:collapse; font-size:14.5px; }
  table.t th { text-align:left; font-family:var(--mono); font-size:11px; font-weight:500; letter-spacing:.1em; text-transform:uppercase;
               color:var(--ink-3); padding:0 14px 8px 0; border-bottom:2px solid var(--rule); white-space:nowrap; }
  table.t td { text-align:left; vertical-align:top; padding:10px 14px 10px 0; border-bottom:1px solid var(--hair); color:var(--ink-2); overflow-wrap:anywhere; }
  table.t tr.total td { color:var(--ink); font-weight:700; border-top:2px solid var(--rule); border-bottom:2px solid var(--rule); }
  table.t td.code { font-family:var(--mono); font-size:12.5px; color:var(--ink); }

  /* commits */
  .commit-row { display:grid; grid-template-columns:auto 1fr auto; gap:4px 14px; align-items:baseline; padding:10px 0; border-bottom:1px solid var(--hair); }
  .commit-row .subject { overflow-wrap:anywhere; }
  .stats { font-family:var(--mono); font-size:13px; white-space:nowrap; }
  .add { color:var(--c3); } .del { color:var(--red); }

  /* a commit, as git show prints it */
  pre.git { background:var(--paper); border:1px solid var(--hair); border-radius:12px; padding:18px 20px; overflow:auto; white-space:pre;
            font-family:var(--mono); font-size:13px; line-height:1.5; }
  pre.git .sha { color:var(--c2); } pre.git .author { color:var(--c1); } pre.git .date { color:var(--ink-3); }
  pre.git .subject { font-weight:700; color:var(--ink); } pre.git .hunk { color:var(--c1); }
  pre.git .fhdr { font-weight:700; color:var(--ink); } pre.git .hdr { color:var(--ink-3); }
  pre.git .add { color:var(--c3); } pre.git .del { color:var(--red); }
  pre.git .ln { display:block; }
  pre.git .ln.add { color:var(--c3); } pre.git .ln.del { color:var(--red); }

  pre.wrap { white-space:pre-wrap; word-break:break-word; }

  /* mechanics: timing and cost */
  .row { display:grid; grid-template-columns:minmax(120px,260px) 1fr 230px; gap:10px; align-items:center; margin:4px 0; }
  .label { font-family:var(--mono); font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .track { position:relative; height:14px; background:var(--hair); }
  .bar-run { position:absolute; top:0; bottom:0; background:var(--ink-3); min-width:3px; }
  .bar-run.review { background:var(--c1); } .bar-run.patterns { background:var(--c5); } .bar-run.fix { background:var(--c3); }
  .bar-run.audit { background:var(--c2); } .bar-run.organize { background:var(--muted); } .bar-run.failed { background:var(--red); }
  .bar-run.live { opacity:.6; background-image:repeating-linear-gradient(45deg,transparent 0 4px,rgba(255,255,255,.5) 4px 8px); }
  .dur { display:grid; grid-template-columns:1fr 7.5em; gap:10px; align-items:center; font-size:12px; color:var(--ink-3); white-space:nowrap; }
  .dur .t { text-align:right; }

  @media (max-width:900px) {
    .sec { display:flex; flex-direction:column; gap:14px; }
    .sec-side { position:static; flex-direction:row; align-items:baseline; gap:14px; }
    .sec-no::before { font-size:2.2rem; }
    .stand { grid-column:1 / -1; }
    .bar ol { justify-content:flex-start; }
    .row { grid-template-columns:minmax(100px,200px) 1fr 210px; }
  }
  @media (max-width:560px) {
    .page { padding:0 16px 80px; }
    body { font-size:16px; }
    .bar-in { padding:0 14px; }
    .bar .mark { display:none; }
    .row { grid-template-columns:1fr 210px; }
    .row .track { grid-column:1 / -1; grid-row:2; }
    .commit-row { grid-template-columns:1fr; }
    pre.git { font-size:12px; }
  }
`;
