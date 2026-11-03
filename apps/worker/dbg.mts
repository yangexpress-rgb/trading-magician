import { FakeAlpaca, FAKE_ALPACA_DATA_URL, FAKE_ALPACA_TRADING_URL } from '@tm/alpaca/testing';
import * as A from '@tm/alpaca';
console.log(Object.keys(A).filter(k=>/client|History/i.test(k)));
