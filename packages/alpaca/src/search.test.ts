import { describe, expect, it } from 'vitest';
import { searchInstruments } from './account';

const listed = [
  { symbol: 'COR', displayName: 'Cencora, Inc. Common Stock' },
  { symbol: 'CORT', displayName: 'Corcept Therapeutics Incorporated Common Stock' },
  { symbol: 'CORZ', displayName: 'Core Scientific, Inc. Common Stock' },
  { symbol: 'BAC', displayName: 'Bank of America Corporation Common Stock' },
  { symbol: 'BK', displayName: 'The Bank of New York Mellon Corporation Common Stock' },
  { symbol: 'NKE', displayName: 'Nike, Inc. Common Stock' },
  { symbol: 'SPY', displayName: 'SPDR S&P 500 ETF Trust' },
];
const symbols = (q: string) => searchInstruments(listed, q).map((i) => i.symbol);

describe('searching listed instruments', () => {
  it('finds a company by name, ignoring case and suffixes', () => {
    expect(symbols('Cencora')).toEqual(['COR']);
    expect(symbols('cencora inc')).toEqual(['COR']);
    expect(symbols('nike')).toEqual(['NKE']);
  });

  it('puts the exact symbol first, then symbols that start with it', () => {
    expect(symbols('COR')).toEqual(['COR', 'CORT', 'CORZ']);
    expect(symbols('cor')[0]).toBe('COR');
  });

  it('matches every word typed, preferring names that start with them', () => {
    expect(symbols('bank of america')).toEqual(['BAC']);
    expect(symbols('bank')).toEqual(['BAC', 'BK']);
    expect(symbols('s&p 500')).toEqual(['SPY']);
  });

  it('finds nothing for blank or unknown text', () => {
    expect(symbols('  ')).toEqual([]);
    expect(symbols('zzzz')).toEqual([]);
  });
});
