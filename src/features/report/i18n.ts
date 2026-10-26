// Report language (RP-26). Fixed report labels are translated here; test and parameter names use an
// optional `translations` map on the catalogue item ({ hi: 'हीमोग्लोबिन' }) and fall back to the English name.
export const REPORT_LANGS: { value: string; label: string }[] = [
  { value: 'en', label: 'English' },
  { value: 'hi', label: 'Hindi' },
  { value: 'mr', label: 'Marathi' },
  { value: 'gu', label: 'Gujarati' },
  { value: 'bn', label: 'Bengali' },
  { value: 'ta', label: 'Tamil' },
]

type Key =
  | 'name' | 'ageGender' | 'patientId' | 'uhid' | 'billNo' | 'phone' | 'referrer' | 'collectedAt' | 'receivedAt' | 'registeredAt'
  | 'reportedAt' | 'sampleType' | 'barcode' | 'address' | 'status' | 'test' | 'result' | 'flag' | 'reference' | 'unit' | 'previous'
  | 'interpretation' | 'comment' | 'note' | 'sample' | 'awaited' | 'abnSummary' | 'endOfReport'

const EN: Record<Key, string> = {
  name: 'Name', ageGender: 'Age / Gender', patientId: 'Patient ID', uhid: 'UHID', billNo: 'Bill No', phone: 'Phone', referrer: 'Referred by',
  collectedAt: 'Collected', receivedAt: 'Received', registeredAt: 'Registered', reportedAt: 'Reported', sampleType: 'Sample type',
  barcode: 'Barcode', address: 'Address', status: 'Report status', test: 'Test', result: 'Result', flag: 'Flag', reference: 'Reference range',
  unit: 'Unit', previous: 'Previous', interpretation: 'Interpretation', comment: 'Comment', note: 'Note', sample: 'Sample',
  awaited: 'Result awaited', abnSummary: 'Summary of abnormal values', endOfReport: '*** End of report ***',
}

const T: Record<string, Partial<Record<Key, string>>> = {
  hi: {
    name: 'नाम', ageGender: 'आयु / लिंग', patientId: 'रोगी आईडी', uhid: 'यूएचआईडी', billNo: 'बिल नं.', phone: 'फ़ोन', referrer: 'रेफर किया',
    collectedAt: 'नमूना लिया', receivedAt: 'प्राप्त', registeredAt: 'पंजीकृत', reportedAt: 'रिपोर्ट', sampleType: 'नमूने का प्रकार', barcode: 'बारकोड',
    address: 'पता', status: 'रिपोर्ट स्थिति', test: 'जाँच', result: 'परिणाम', flag: 'संकेत', reference: 'सामान्य सीमा', unit: 'इकाई', previous: 'पिछला',
    interpretation: 'व्याख्या', comment: 'टिप्पणी', note: 'नोट', sample: 'नमूना', awaited: 'परिणाम प्रतीक्षित', abnSummary: 'असामान्य मानों का सारांश',
    endOfReport: '*** रिपोर्ट समाप्त ***',
  },
  mr: {
    name: 'नाव', ageGender: 'वय / लिंग', patientId: 'रुग्ण आयडी', uhid: 'यूएचआयडी', billNo: 'बिल क्र.', phone: 'फोन', referrer: 'संदर्भित',
    collectedAt: 'नमुना घेतला', receivedAt: 'प्राप्त', registeredAt: 'नोंदणी', reportedAt: 'अहवाल', sampleType: 'नमुन्याचा प्रकार', barcode: 'बारकोड',
    address: 'पत्ता', status: 'अहवाल स्थिती', test: 'चाचणी', result: 'निकाल', flag: 'चिन्ह', reference: 'सामान्य मर्यादा', unit: 'एकक', previous: 'मागील',
    interpretation: 'अर्थ', comment: 'टिप्पणी', note: 'टीप', sample: 'नमुना', awaited: 'निकाल प्रतीक्षेत', abnSummary: 'असामान्य मूल्यांचा सारांश',
    endOfReport: '*** अहवाल समाप्त ***',
  },
  gu: {
    name: 'નામ', ageGender: 'ઉંમર / જાતિ', patientId: 'દર્દી આઈડી', uhid: 'યુએચઆઈડી', billNo: 'બિલ નં.', phone: 'ફોન', referrer: 'રેફર કર્યા',
    collectedAt: 'નમૂનો લીધો', receivedAt: 'પ્રાપ્ત', registeredAt: 'નોંધણી', reportedAt: 'રિપોર્ટ', sampleType: 'નમૂનાનો પ્રકાર', barcode: 'બારકોડ',
    address: 'સરનામું', status: 'રિપોર્ટ સ્થિતિ', test: 'તપાસ', result: 'પરિણામ', flag: 'સંકેત', reference: 'સામાન્ય મર્યાદા', unit: 'એકમ', previous: 'અગાઉનું',
    interpretation: 'અર્થઘટન', comment: 'ટિપ્પણી', note: 'નોંધ', sample: 'નમૂનો', awaited: 'પરિણામ બાકી', abnSummary: 'અસામાન્ય મૂલ્યોનો સારાંશ',
    endOfReport: '*** રિપોર્ટ સમાપ્ત ***',
  },
  bn: {
    name: 'নাম', ageGender: 'বয়স / লিঙ্গ', patientId: 'রোগীর আইডি', uhid: 'ইউএইচআইডি', billNo: 'বিল নং', phone: 'ফোন', referrer: 'রেফার করেছেন',
    collectedAt: 'নমুনা সংগ্রহ', receivedAt: 'গৃহীত', registeredAt: 'নিবন্ধিত', reportedAt: 'রিপোর্ট', sampleType: 'নমুনার ধরন', barcode: 'বারকোড',
    address: 'ঠিকানা', status: 'রিপোর্টের অবস্থা', test: 'পরীক্ষা', result: 'ফলাফল', flag: 'চিহ্ন', reference: 'স্বাভাবিক সীমা', unit: 'একক', previous: 'আগের',
    interpretation: 'ব্যাখ্যা', comment: 'মন্তব্য', note: 'নোট', sample: 'নমুনা', awaited: 'ফলাফল অপেক্ষমাণ', abnSummary: 'অস্বাভাবিক মানের সারাংশ',
    endOfReport: '*** রিপোর্ট শেষ ***',
  },
  ta: {
    name: 'பெயர்', ageGender: 'வயது / பாலினம்', patientId: 'நோயாளி எண்', uhid: 'யூஎச்ஐடி', billNo: 'பில் எண்', phone: 'தொலைபேசி', referrer: 'பரிந்துரைத்தவர்',
    collectedAt: 'மாதிரி எடுக்கப்பட்டது', receivedAt: 'பெறப்பட்டது', registeredAt: 'பதிவு', reportedAt: 'அறிக்கை', sampleType: 'மாதிரி வகை', barcode: 'பார்கோடு',
    address: 'முகவரி', status: 'அறிக்கை நிலை', test: 'பரிசோதனை', result: 'முடிவு', flag: 'குறி', reference: 'இயல்பு வரம்பு', unit: 'அலகு', previous: 'முந்தையது',
    interpretation: 'விளக்கம்', comment: 'கருத்து', note: 'குறிப்பு', sample: 'மாதிரி', awaited: 'முடிவு காத்திருக்கிறது', abnSummary: 'அசாதாரண மதிப்புகளின் சுருக்கம்',
    endOfReport: '*** அறிக்கை முடிவு ***',
  },
}

export const tr = (lang: string | undefined, key: Key): string => (lang && lang !== 'en' ? T[lang]?.[key] : undefined) ?? EN[key]

// Catalogue name in the report language (falls back to the English name).
export const nameIn = (item: { name: string; translations?: Record<string, string> }, lang: string | undefined): string =>
  (lang && lang !== 'en' ? item.translations?.[lang]?.trim() : '') || item.name
