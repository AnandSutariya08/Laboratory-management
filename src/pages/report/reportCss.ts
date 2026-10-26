export const ACCENT = '#0369A1'

export const reportCss = `
.rpt { background:#fff; color:#111; margin:0 auto; box-sizing:border-box; font-family:Inter,Arial,sans-serif; font-size:12px; position:relative; }
.rpt table { border-collapse:collapse; width:100%; }
.rpt .hdr { text-align:center; border-bottom:3px solid ${ACCENT}; padding-bottom:6px; margin-bottom:8px; }
.rpt .hdr img.hi { max-width:100%; max-height:90px; }
.rpt .hdr img.logo { max-height:56px; }
.rpt .pat { display:grid; grid-template-columns:1fr 1fr; gap:2px 18px; margin:4px 0 8px; }
.rpt .pat div { display:flex; gap:6px; }
.rpt .pat .k { color:#555; min-width:90px; }
.rpt .ids { display:flex; justify-content:space-between; align-items:center; margin-bottom:6px; gap:12px; }
.rpt .ids img { height:64px; width:64px; }
.rpt h3.dept { margin:14px 0 4px; padding:3px 8px; background:#E0F2FE; color:#0369A1; font-size:13px; text-transform:uppercase; letter-spacing:.5px; }
.rpt h4.tname { margin:8px 0 3px; font-size:12.5px; }
.rpt table.res th { text-align:left; font-size:11px; color:#555; border-bottom:1px solid #999; padding:2px 4px; }
.rpt table.res td { padding:2px 4px; border-bottom:1px dotted #ddd; vertical-align:top; }
.rpt tr.abn-bold td, .rpt tr.abn-both td { font-weight:700; }
.rpt tr.abn-colour td.val, .rpt tr.abn-both td.val { color:#b91c1c; }
.rpt tr.grp td { font-weight:700; color:#0369A1; padding-top:6px; }
.rpt .block { break-inside:avoid; page-break-inside:avoid; }
.rpt .note { margin-top:4px; font-size:11px; white-space:pre-wrap; }
.rpt .issue { margin-top:4px; font-size:11px; color:#92400e; }
.rpt .await { color:#92400e; font-style:italic; padding:3px 0; }
.rpt .rejected { color:#b91c1c; padding:3px 0; }
.rpt .appr { margin-top:18px; display:flex; flex-wrap:wrap; gap:28px; justify-content:flex-end; font-size:11px; }
.rpt .sig { text-align:center; min-width:130px; }
.rpt .sig img { max-height:48px; max-width:160px; display:block; margin:0 auto 2px; }
.rpt .sig img.stamp { max-height:56px; max-width:90px; opacity:.85; }
.rpt .sig-fixed { display:none; }
.rpt .end { text-align:center; margin-top:14px; font-size:11px; color:#555; border-top:1px solid #bbb; padding-top:6px; }
.rpt .ftr { border-top:3px solid ${ACCENT}; margin-top:10px; padding-top:4px; text-align:center; font-size:10px; color:#555; }
.rpt .summary h3 { margin:0 0 6px; color:#0369A1; }
.rpt .pgbreak { break-after:page; page-break-after:always; }
.rpt .banner { margin:0 0 8px; padding:5px 8px; border:1.5px solid #92400e; color:#92400e; font-weight:700; text-align:center; letter-spacing:.5px; font-size:11.5px; }
.rpt .banner.amend { border-color:#b91c1c; color:#b91c1c; }
.rpt .banner small { display:block; font-weight:400; letter-spacing:0; }
.rpt .wm { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; pointer-events:none; z-index:0; overflow:hidden; }
.rpt .wm span { font-size:84px; font-weight:800; color:#0000000d; transform:rotate(-30deg); white-space:nowrap; }
.rpt .wm img { max-width:55%; max-height:40%; opacity:.06; }
.rpt .content { position:relative; z-index:1; }
.rpt .smp { font-size:10.5px; color:#555; margin:0 0 2px; }
.rpt .pgbefore { break-before:page; page-break-before:always; }
.rpt .filebox { width:100%; height:240mm; border:1px solid #ccc; }
.rpt .rich { white-space:normal; }
.rpt .rich ul, .rpt .rich ol { margin:2px 0; padding-left:18px; }
.rpt .pimg { max-width:100%; max-height:200px; }
.rpt .ppdf { width:100%; height:200px; border:1px solid #ccc; }
.rpt .rad h5 { margin:6px 0 2px; font-size:11px; text-transform:uppercase; color:#555; }
.rpt .rad p { margin:0; white-space:pre-wrap; }
.rpt .rad .imgs { display:flex; flex-wrap:wrap; gap:6px; margin-top:6px; }
.rpt .rad .imgs img { height:110px; }
@media screen { .rpt { box-shadow:0 2px 12px #0002; margin-bottom:24px; padding:10mm 12mm; } }
@media print {
  @page { margin:0; }
  body { background:#fff !important; }
  .rpt { box-shadow:none; margin:0; }
  .rpt.every-sig .sig-fixed { display:flex; position:fixed; bottom:12mm; right:12mm; gap:28px; font-size:11px; }
}
`
