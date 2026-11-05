/**
 * The parts of EDGAR's JSON the app reads, as the SEC documents them at
 * https://www.sec.gov/search-filings/edgar-application-programming-interfaces.
 * `testing/fixtures` holds transcribed examples of each.
 */

/** www.sec.gov/files/company_tickers_exchange.json */
export interface SecTickerFile {
  fields: string[];
  data: (string | number | null)[][];
}

export interface SecAddress {
  street1: string | null;
  street2: string | null;
  city: string | null;
  stateOrCountry: string | null;
  zipCode: string | null;
  stateOrCountryDescription: string | null;
}

/** data.sec.gov/submissions/CIK##########.json */
export interface SecSubmissions {
  cik: string;
  entityType: string | null;
  sic: string | null;
  sicDescription: string | null;
  name: string;
  tickers: string[];
  exchanges: (string | null)[];
  website: string | null;
  investorWebsite: string | null;
  category: string | null;
  fiscalYearEnd: string | null;
  stateOfIncorporation: string | null;
  stateOfIncorporationDescription: string | null;
  addresses: { mailing?: SecAddress; business?: SecAddress };
  phone: string | null;
  formerNames: { name: string; from: string | null; to: string | null }[];
  filings: {
    recent: {
      accessionNumber: string[];
      filingDate: string[];
      reportDate: string[];
      form: string[];
      primaryDocument: string[];
      primaryDocDescription: string[];
    };
  };
}

/** One reported value of a concept. */
export interface SecFact {
  /** Present for durations, such as a year's revenue. */
  start?: string;
  end: string;
  val: number;
  accn: string;
  fy: number | null;
  fp: string | null;
  form: string;
  filed: string;
  frame?: string;
}

export interface SecConcept {
  label: string | null;
  description: string | null;
  units: Record<string, SecFact[]>;
}

/** data.sec.gov/api/xbrl/companyfacts/CIK##########.json */
export interface SecCompanyFacts {
  cik: number;
  entityName: string;
  facts: Record<string, Record<string, SecConcept> | undefined>;
}

/** data.sec.gov/api/xbrl/companyconcept/CIK##########/{taxonomy}/{tag}.json */
export interface SecCompanyConcept {
  cik: number;
  taxonomy: string;
  tag: string;
  label: string | null;
  description: string | null;
  entityName: string;
  units: Record<string, SecFact[]>;
}

/** data.sec.gov/api/xbrl/frames/{taxonomy}/{tag}/{unit}/{period}.json */
export interface SecFrame {
  taxonomy: string;
  tag: string;
  ccp: string;
  uom: string;
  label: string | null;
  description: string | null;
  pts: number;
  data: {
    accn: string;
    cik: number;
    entityName: string;
    loc: string | null;
    start?: string;
    end: string;
    val: number;
  }[];
}
