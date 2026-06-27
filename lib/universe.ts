/**
 * 取引対象ユニバース（約300銘柄）
 * ボラティリティが高く流動性のある米国株を幅広いセクターから選定。
 *
 * 注意（サバイバーシップバイアス）: このリストは「現在生き残っている銘柄」で構成される。
 * 過去に上場廃止・破綻・合併した銘柄を含まないため、過去相場のバックテスト結果は
 * 実際よりやや良く出る傾向がある。本番は厳選120銘柄（大型・流動性上位）に限定し、
 * 投機的な低位株は株価/売買代金フィルタで除外することで影響を抑えている。
 */
export const UNIVERSE: string[] = [
  // テクノロジー大型
  "AAPL","MSFT","GOOGL","META","AMZN","TSLA","NVDA","AMD","AVGO","ORCL",
  "CRM","ADBE","INTC","QCOM","TXN","MU","AMAT","LRCX","KLAC","MRVL",
  "SNPS","CDNS","ANSS","FTNT","PANW","CRWD","ZS","OKTA","DDOG","NET",
  "SNOW","MDB","GTLB","PATH","U","RBLX","COIN","HOOD","SOFI","AFRM",

  // AI・クラウド
  "PLTR","AI","BBAI","SOUN","CEVA","AIXI","GFAI","SoundHound",
  "MSAI","AMBA","SMCI","DELL","HPE","PSTG","NTAP",

  // 半導体・製造装置
  "WOLF","ON","SWKS","QRVO","MPWR","SITM","DIOD","IOSP","COHU","ACLS",
  "ONTO","FORM","ICHR","CAMT","RMBS","SLAB","MAXN","POWI","IXYS",

  // フィンテック・金融
  "JPM","BAC","GS","MS","WFC","C","BLK","SCHW","AXP","V","MA","PYPL",
  "SQ","NDAQ","ICE","CME","CBOE","MKTX","LPLA","RJF","IBKR","ALLY",
  "LC","UPST","OPEN","RDFN","UWMC",

  // ヘルスケア・バイオ
  "JNJ","PFE","MRK","ABBV","LLY","BMY","AMGN","GILD","BIIB","REGN",
  "VRTX","MRNA","BNTX","NVAX","SGEN","ALNY","IONS","ACAD","ARWR","BEAM",
  "CRSP","EDIT","NTLA","FATE","KYMR","IMVT","RCKT","PRAX","SAGE","AXSM",
  "INVA","HALO","EXEL","FOLD","TGTX","URGN","PCVX","RVMD","DNLI",

  // エネルギー
  "XOM","CVX","COP","SLB","HAL","BKR","PSX","VLO","MPC","OXY",
  "DVN","FANG","PXD","EOG","EQT","AR","CTRA","RRC","SM","CHK",
  "DINO","PARR","CLNE","PLUG","FCEL","BE","BLDP","HTOO",

  // 消費財・小売
  "WMT","COST","TGT","HD","LOW","AMZN","BABA","JD","PDD","SE",
  "SHOP","ETSY","EBAY","W","RVLV","CPNG","MELI","GLOB",
  "NKE","UAA","LULU","PVH","RL","HBI","GES","EXPR","ANF","AEO",

  // メディア・エンタメ
  "NFLX","DIS","WBD","PARA","FOXA","CMCSA","SPOT","SNAP","PINS","TWTR",
  "RBLX","U","EA","TTWO","ATVI","ZNGA","GLUU","SKLZ",

  // 不動産・REIT
  "AMT","PLD","EQIX","CCI","SPG","O","WELL","VTR","PSA","EXR",
  "IRM","SBAC","DLR","ARE","BXP","SLG","KIM","REG","FRT",

  // 素材・化学
  "LIN","APD","ECL","DD","DOW","LYB","PPG","SHW","VMC","MLM",
  "NUE","STLD","RS","X","CLF","AA","FCX","MP","MPAC",

  // 輸送・物流
  "UPS","FDX","XPO","SAIA","ODFL","JBHT","CHRW","EXPD","GXO","UBER",
  "LYFT","DASH","DKNG","ABNB","BKNG","EXPE","TRIP","DESP",

  // 航空・防衛
  "LMT","RTX","NOC","GD","BA","HII","TDG","HEI","AXON","KTOS",
  "RCAT","JOBY","ACHR","LILM","WKHS","NKLA","RIDE",

  // 電気自動車・次世代モビリティ
  "TSLA","RIVN","LCID","FSR","XPEV","NIO","LI","BLNK","CHPT","EVGO",
  "PTRA","DRVN","GOEV","SOLO","KNDI",

  // 宇宙・衛星（AI判断用、ユーザー長期保有とは別枠でデイトレ対象）
  "RKLB","ASTS","MNTS","ASTR","SPCE","VORB","RDW","SATL",

  // 量子・先端技術
  "IONQ","RGTI","QUBT","QBTS","IBM","ARQQ",

  // ミーム株・高ボラ
  "GME","AMC","BBBY","CLOV","WISH","WKHS","MVIS","SPCE","GNUS",
  "NAKD","EXPR","KOSS","BB","NOK","SNDL","TLRY","APHA","CGC","ACB",
  "CRON","HEXO","OGI","KERN","IIPR",

  // ETF（方向性ヘッジ用）
  "SPY","QQQ","IWM","SOXS","SOXL","TQQQ","SQQQ","UVXY","VIX",
  "GLD","SLV","USO","TLT","HYG","XLK","XLF","XLE","XLV","XLI",
];

// 重複除去
export const UNIVERSE_TICKERS = [...new Set(UNIVERSE)];
