export interface AccountBalance {
  name: string;
  currency: string;
  balance: number;
  number: string;
}

export interface BalanceSummary {
  totalBalance: number;
  currencyEquivalent: string;
  accounts: AccountBalance[];
}

export interface Transaction {
  postDate: string;
  transactionDate: string;
  accountNumber: string;
  creditAmount: number;
  debitAmount: number;
  currency: string;
  description: string;
  availableBalance: number;
  refNo: string;
  beneficiaryName?: string;
  beneficiaryBank?: string;
  beneficiaryAccount?: string;
  type?: string;
}

export interface SessionState {
  sessionId: string;
  deviceId: string;
  username: string;
  createdAt: number;
}

export interface CaptchaResponse {
  imageBase64: string;
  deviceId: string;
}

export interface AccountInfo {
  accountNo: string;
  accountName: string;
  bankCode: string;
  bankName: string;
}

export interface TransferParams {
  fromAccount: string;
  toAccount: string;
  toAccountName: string;
  bankCode: string;
  bankName: string;
  amount: number;
  description: string;
}

export interface TransferResult {
  success: boolean;
  message?: string;
  transactionId?: string;
  requiresOtp?: boolean;
}
