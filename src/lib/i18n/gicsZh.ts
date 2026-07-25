/** GICS 板块 / 子行业 → 中文（用于每日筛选展示） */

const SECTOR_ZH: Record<string, string> = {
  "Energy": "能源",
  "Materials": "原材料",
  "Industrials": "工业",
  "Consumer Discretionary": "非必需消费",
  "Consumer Staples": "必需消费",
  "Health Care": "医疗健康",
  "Financials": "金融",
  "Information Technology": "信息技术",
  "Technology": "信息技术",
  "Communication Services": "通信服务",
  "Utilities": "公用事业",
  "Real Estate": "房地产",
};

const INDUSTRY_ZH: Record<string, string> = {
  // Energy
  "Oil & Gas Exploration & Production": "油气勘探开采",
  "Oil & Gas Refining & Marketing": "炼油与营销",
  "Oil & Gas Storage & Transportation": "油气储运",
  "Oil & Gas Equipment & Services": "油气设备与服务",
  "Integrated Oil & Gas": "综合油气",
  "Coal & Consumable Fuels": "煤炭与燃料",
  // Materials
  "Specialty Chemicals": "特种化工",
  "Commodity Chemicals": "大宗化工",
  "Fertilizers & Agricultural Chemicals": "化肥与农化",
  "Industrial Gases": "工业气体",
  "Construction Materials": "建材",
  "Metal, Glass & Plastic Containers": "金属玻璃塑料容器",
  "Gold": "黄金",
  "Copper": "铜",
  "Steel": "钢铁",
  "Aluminum": "铝",
  "Diversified Metals & Mining": "多元金属与采矿",
  "Paper & Forest Products": "造纸与林产品",
  // Industrials
  "Aerospace & Defense": "航空航天与国防",
  "Building Products": "建筑产品",
  "Construction & Engineering": "工程建筑",
  "Electrical Components & Equipment": "电气部件与设备",
  "Industrial Machinery & Supplies & Components": "工业机械与零部件",
  "Industrial Conglomerates": "工业综合集团",
  "Trading Companies & Distributors": "贸易与分销",
  "Commercial Printing": "商业印刷",
  "Environmental & Facilities Services": "环境与设施服务",
  "Office Services & Supplies": "办公服务与用品",
  "Diversified Support Services": "多元支持服务",
  "Security & Alarm Services": "安防服务",
  "Human Resource & Employment Services": "人力资源服务",
  "Research & Consulting Services": "研究与咨询",
  "Data Processing & Outsourced Services": "数据处理与外包",
  "Air Freight & Logistics": "航空货运与物流",
  "Passenger Airlines": "客运航空",
  "Marine Transportation": "海运",
  "Rail Transportation": "铁路运输",
  "Cargo Ground Transportation": "公路货运",
  "Passenger Ground Transportation": "公路客运",
  "Airport Services": "机场服务",
  "Highways & Railtracks": "公路与铁轨",
  "Marine Ports & Services": "港口服务",
  // Consumer Discretionary
  "Automobile Manufacturers": "整车制造",
  "Motorcycle Manufacturers": "摩托车制造",
  "Consumer Electronics": "消费电子",
  "Home Furnishings": "家居用品",
  "Homebuilding": "住宅建造",
  "Household Appliances": "家用电器",
  "Housewares & Specialties": "家居特色用品",
  "Leisure Products": "休闲用品",
  "Apparel, Accessories & Luxury Goods": "服装配饰与奢侈品",
  "Footwear": "鞋履",
  "Textiles": "纺织",
  "Casinos & Gaming": "博彩",
  "Hotels, Resorts & Cruise Lines": "酒店度假与邮轮",
  "Leisure Facilities": "休闲设施",
  "Restaurants": "餐饮",
  "Education Services": "教育服务",
  "Specialized Consumer Services": "特色消费服务",
  "Distributors": "分销商",
  "Broadline Retail": "综合零售",
  "Apparel Retail": "服装零售",
  "Computer & Electronics Retail": "电脑与电子零售",
  "Home Improvement Retail": "家居建材零售",
  "Other Specialty Retail": "其他专卖零售",
  "Automotive Retail": "汽车零售",
  "Homefurnishing Retail": "家居零售",
  // Consumer Staples
  "Drug Retail": "药品零售",
  "Food Distributors": "食品分销",
  "Food Retail": "食品零售",
  "Consumer Staples Merchandise Retail": "必需消费品零售",
  "Brewers": "啤酒",
  "Distillers & Vintners": "烈酒与葡萄酒",
  "Soft Drinks & Non-alcoholic Beverages": "软饮料",
  "Agricultural Products & Services": "农产品与服务",
  "Packaged Foods & Meats": "包装食品与肉类",
  "Tobacco": "烟草",
  "Household Products": "家庭用品",
  "Personal Care Products": "个人护理",
  // Health Care
  "Health Care Equipment": "医疗设备",
  "Health Care Supplies": "医疗耗材",
  "Health Care Distributors": "医疗分销",
  "Health Care Services": "医疗服务",
  "Health Care Facilities": "医疗机构",
  "Managed Health Care": "管理式医疗",
  "Health Care Technology": "医疗科技",
  "Biotechnology": "生物科技",
  "Pharmaceuticals": "制药",
  "Life Sciences Tools & Services": "生命科学工具与服务",
  // Financials
  "Diversified Banks": "多元化银行",
  "Regional Banks": "地区性银行",
  "Diversified Financial Services": "多元金融服务",
  "Multi-Sector Holdings": "多行业控股",
  "Specialized Finance": "专业金融",
  "Consumer Finance": "消费金融",
  "Asset Management & Custody Banks": "资管与托管银行",
  "Investment Banking & Brokerage": "投行与经纪",
  "Diversified Capital Markets": "多元资本市场",
  "Financial Exchanges & Data": "金融交易所与数据",
  "Mortgage Real Estate Investment Trusts (REITs)": "抵押型REIT",
  "Insurance Brokers": "保险经纪",
  "Life & Health Insurance": "人寿与健康保险",
  "Multi-line Insurance": "综合保险",
  "Property & Casualty Insurance": "财产与意外保险",
  "Reinsurance": "再保险",
  // Technology
  "IT Consulting & Other Services": "IT咨询与服务",
  "Internet Services & Infrastructure": "互联网服务与基础设施",
  "Application Software": "应用软件",
  "Systems Software": "系统软件",
  "Communications Equipment": "通信设备",
  "Technology Hardware, Storage & Peripherals": "科技硬件存储与外设",
  "Electronic Equipment & Instruments": "电子设备与仪器",
  "Electronic Components": "电子元件",
  "Electronic Manufacturing Services": "电子制造服务",
  "Technology Distributors": "科技分销",
  "Semiconductor Materials & Equipment": "半导体材料与设备",
  "Semiconductors": "半导体",
  // Communication
  "Alternative Carriers": "另类通信运营商",
  "Integrated Telecommunication Services": "综合电信服务",
  "Wireless Telecommunication Services": "无线电信服务",
  "Advertising": "广告",
  "Broadcasting": "广播",
  "Cable & Satellite": "有线与卫星",
  "Publishing": "出版",
  "Movies & Entertainment": "影视娱乐",
  "Interactive Home Entertainment": "互动家庭娱乐",
  "Interactive Media & Services": "互动媒体与服务",
  // Utilities
  "Electric Utilities": "电力公用",
  "Gas Utilities": "燃气公用",
  "Multi-Utilities": "综合公用",
  "Water Utilities": "水务公用",
  "Independent Power Producers & Energy Traders": "独立发电与能源交易",
  "Renewable Electricity": "可再生电力",
  // Real Estate
  "Diversified REITs": "多元REIT",
  "Industrial REITs": "工业REIT",
  "Hotel & Resort REITs": "酒店度假REIT",
  "Office REITs": "办公REIT",
  "Health Care REITs": "医疗REIT",
  "Residential REITs": "住宅REIT",
  "Retail REITs": "零售REIT",
  "Specialized REITs": "特种REIT",
  "Real Estate Services": "房地产服务",
  "Real Estate Development": "房地产开发",
  "Real Estate Operating Companies": "房地产运营公司",
  "Telecom Tower REITs": "通信塔REIT",
  "Self-Storage REITs": "自助仓储REIT",
  "Timber REITs": "林木REIT",
  "Data Center REITs": "数据中心REIT",
};

export function toSectorZh(sector: string | null | undefined): string {
  if (!sector) return "未知板块";
  return SECTOR_ZH[sector] ?? sector;
}

export function toIndustryZh(industry: string | null | undefined): string {
  if (!industry) return "未知细分";
  return INDUSTRY_ZH[industry] ?? industry;
}

/** 中文简介：尽量短，只保留板块/细分（公司名另栏展示） */
export function buildZhBlurb(
  _name: string,
  sector: string | null | undefined,
  industry: string | null | undefined,
): string {
  return formatIndustryLabel(sector, industry);
}

export function formatIndustryLabel(
  sector: string | null | undefined,
  industry: string | null | undefined,
): string {
  const s = toSectorZh(sector);
  const i = toIndustryZh(industry);
  if (!sector && !industry) return "行业未知";
  if (!industry || i === s) return s;
  return `${s}｜${i}`;
}
