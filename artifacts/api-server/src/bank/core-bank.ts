/**
 * Core Bank Service — kết nối MB Bank Internet Banking
 */

import { createHash } from "node:crypto";
import { Client } from "undici";
import { encrypt } from "./wasm-engine";
import { recognizeCaptcha } from "./captcha-ocr";
import type { SessionState, BalanceSummary, AccountBalance, Transaction, AccountInfo, TransferParams, TransferResult } from "./types";

const BASE_URL = "https://online.mbbank.com.vn";

const DEFAULT_HEADERS: Record<string, string> = {
  "Cache-Control": "max-age=0",
  Accept: "application/json, text/plain, */*",
  Authorization: "Basic RU1CUkVUQUlMV0VCOlNEMjM0ZGZnMzQlI0BGR0AzNHNmc2RmNDU4NDNm",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
  Origin: BASE_URL,
  Referer: `${BASE_URL}/pl/login?returnUrl=%2F`,
  "Content-Type": "application/json; charset=UTF-8",
  app: "MB_WEB",
  "elastic-apm-traceparent": "00-55b950e3fcabc785fa6db4d7deb5ef73-8dbd60b04eda2f34-01",
  "Sec-Ch-Ua": '"Not.A/Brand";v="8", "Chromium";v="134", "Google Chrome";v="134"',
  "Sec-Ch-Ua-Mobile": "?0",
  "Sec-Ch-Ua-Platform": '"Windows"',
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-origin",
};

const FPR = "c7a1beebb9400375bb187daa33de9659";

function timestamp(): string {
  const now = new Date();
  const pad = (n: number, len = 2) => String(n).padStart(len, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}${String(now.getMilliseconds()).slice(0, 2)}`;
}

function generateDeviceId(): string {
  return `s1rmi184-mbib-0000-0000-${timestamp()}`;
}

function md5(input: string): string {
  return createHash("md5").update(input).digest("hex");
}

async function safeJson(body: { text(): Promise<string> }): Promise<any> {
  try {
    const text = await body.text();
    if (!text?.trim()) return null;
    return JSON.parse(text);
  } catch { return null; }
}

export class CoreBankService {
  private client = new Client(BASE_URL, {
    bodyTimeout: 15_000,
    headersTimeout: 10_000,
    connect: { timeout: 10_000 },
  });
  private session: SessionState | null = null;
  private savedCreds: { username: string; password: string } | null = null;

  getSession(): SessionState | null { return this.session; }
  hasCredentials(): boolean { return this.savedCreds !== null; }

  async reAuthenticate(): Promise<boolean> {
    if (!this.savedCreds) return false;
    try {
      const result = await this.autoLogin(this.savedCreds.username, this.savedCreds.password);
      return result.success;
    } catch { return false; }
  }

  async getCaptcha(): Promise<{ imageBase64: string; deviceId: string }> {
    const deviceId = generateDeviceId();
    const refNo = timestamp();
    const res = await this.client.request({
      method: "POST",
      path: "/api/retail-internetbankingms/getCaptchaImage",
      headers: { ...DEFAULT_HEADERS, "X-Request-Id": refNo, Deviceid: deviceId, Refno: refNo },
      body: JSON.stringify({ sessionId: "", refNo, deviceIdCommon: deviceId }),
    });
    const data = await safeJson(res.body);

    // Field thực tế MB Bank trả về là "imageString"
    const imageData: string | undefined =
      data?.imageString ?? data?.imageData ?? data?.imageBase64 ?? data?.captchaBase64;

    if (!imageData) {
      const preview = JSON.stringify(data)?.slice(0, 200) ?? "null";
      throw new Error(`Không lấy được captcha. Response: ${preview}`);
    }
    return { imageBase64: imageData, deviceId };
  }

  async autoLogin(username: string, password: string): Promise<{
    success: boolean;
    message?: string;
    needManualCaptcha?: boolean;
    captchaBase64?: string;
    deviceId?: string;
  }> {
    // Thử OCR tối đa 3 lần, nếu fail → trả về ảnh captcha cho user tự nhập
    let lastDeviceId = "";
    let lastCaptchaBase64 = "";

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const { imageBase64, deviceId } = await this.getCaptcha();
        lastDeviceId = deviceId;
        lastCaptchaBase64 = imageBase64;

        const imgBuf = Buffer.from(imageBase64, "base64");
        const captcha = await recognizeCaptcha(imgBuf);
        if (!captcha) continue; // OCR không nhận diện được → thử lại

        const result = await this.loginWithCaptcha(username, password, captcha, deviceId);
        if (result.success) {
          this.savedCreds = { username, password };
          return result;
        }
        // Sai thông tin đăng nhập (không phải sai captcha) → dừng ngay
        const msg = result.message?.toLowerCase() ?? "";
        if (msg.includes("sai") || msg.includes("incorrect") || msg.includes("invalid") || msg.includes("không đúng")) {
          return result;
        }
        // Sai captcha → thử lại
      } catch (err: any) {
        if (attempt === 2) {
          // Lần cuối vẫn lỗi → fallback manual
          break;
        }
      }
    }

    // OCR thất bại sau 3 lần → gửi ảnh captcha cho user tự nhập
    if (lastCaptchaBase64) {
      return {
        success: false,
        needManualCaptcha: true,
        captchaBase64: lastCaptchaBase64,
        deviceId: lastDeviceId,
        message: "Không thể nhận diện captcha tự động",
      };
    }
    return { success: false, message: "Không thể lấy captcha từ MB Bank" };
  }

  /** Đăng nhập với captcha do user nhập tay */
  async loginManual(username: string, password: string, captcha: string, deviceId: string): Promise<{ success: boolean; message?: string }> {
    const result = await this.loginWithCaptcha(username, password, captcha, deviceId);
    if (result.success) this.savedCreds = { username, password };
    return result;
  }

  private async loginWithCaptcha(
    username: string,
    password: string,
    captchaCode: string,
    deviceId: string,
  ): Promise<{ success: boolean; message?: string }> {
    const refNo = timestamp();
    const requestData: Record<string, unknown> = {
      userId: username,
      password: md5(password),
      captcha: captchaCode,
      ibAuthen2faString: FPR,
      sessionId: null,
      refNo,
      deviceIdCommon: deviceId,
    };

    const dataEnc = await encrypt(requestData, "0");

    const res = await this.client.request({
      method: "POST",
      path: "/api/retail_web/internetbanking/v2.0/doLogin",
      headers: { ...DEFAULT_HEADERS, "X-Request-Id": refNo, Deviceid: deviceId, Refno: refNo },
      body: JSON.stringify({ dataEnc }),
    });

    const data = await safeJson(res.body);
    if (!data?.result) return { success: false, message: "Không nhận được phản hồi từ MB Bank" };

    if (data.result.ok) {
      this.session = { sessionId: data.sessionId, deviceId, username, createdAt: Date.now() };
      return { success: true };
    }

    return { success: false, message: data.result.message || `Lỗi: ${data.result.responseCode}` };
  }

  async getBalance(): Promise<BalanceSummary | null> {
    const data = await this.authenticatedRequest(
      "/api/retail-accountms/accountms/getBalance",
      {},
    );
    if (!data) return null;

    const accounts: AccountBalance[] = [];

    for (const acct of data.acct_list || []) {
      accounts.push({
        number: acct.acctNo,
        name: acct.acctNm,
        currency: acct.ccyCd,
        balance: acct.currentBalance,
      });
    }

    for (const acct of data.internationalAcctList || []) {
      accounts.push({
        number: acct.acctNo,
        name: acct.acctNm,
        currency: acct.ccyCd,
        balance: acct.currentBalance,
      });
    }

    return {
      totalBalance: data.totalBalanceEquivalent,
      currencyEquivalent: data.currencyEquivalent,
      accounts,
    };
  }

  async getTransactions(accountNumber: string, fromDate: string, toDate: string): Promise<Transaction[]> {
    const data = await this.authenticatedRequest(
      "/api/retail-transactionms/transactionms/get-account-transaction-history",
      { accountNo: accountNumber, fromDate, toDate },
    );
    if (!data?.transactionHistoryList) return [];

    return data.transactionHistoryList.map((tx: any): Transaction => ({
      postDate: tx.postingDate,
      transactionDate: tx.transactionDate,
      accountNumber: tx.accountNo,
      creditAmount: tx.creditAmount,
      debitAmount: tx.debitAmount,
      currency: tx.currency,
      description: tx.description,
      availableBalance: tx.availableBalance,
      refNo: tx.refNo,
      beneficiaryName: tx.benAccountName,
      beneficiaryBank: tx.bankName,
      beneficiaryAccount: tx.benAccountNo,
    }));
  }

  /** Tra cứu thông tin tài khoản thụ hưởng */
  async inquiryAccount(accountNo: string, bankCode = "MB"): Promise<AccountInfo | null> {
    if (!this.session?.sessionId) throw new Error("Chưa đăng nhập");
    const refNo = timestamp();
    const payload = {
      accountNo,
      benBankCode: bankCode,
      ibAuthen2faString: FPR,
      sessionId: this.session.sessionId,
      refNo,
      deviceIdCommon: this.session.deviceId,
    };
    const dataEnc = await encrypt(payload, this.session.sessionId);
    const res = await this.client.request({
      method: "POST",
      path: "/api/retail_web/internetbanking/v2.0/inquiryAccount",
      headers: { ...DEFAULT_HEADERS, "X-Request-Id": refNo, Deviceid: this.session.deviceId, Refno: refNo },
      body: JSON.stringify({ dataEnc }),
    });
    const data = await safeJson(res.body);
    if (!data?.result?.ok) {
      const msg = data?.result?.message || data?.result?.responseCode || "Không tra được tài khoản";
      throw new Error(msg);
    }
    return {
      accountNo: data.benAccountName ? accountNo : (data.accountNo || accountNo),
      accountName: data.benAccountName || data.accountName || "",
      bankCode,
      bankName: data.bankName || bankCode,
    };
  }

  /** Khởi tạo lệnh chuyển tiền, MB Bank sẽ gửi OTP về điện thoại */
  async initiateTransfer(params: TransferParams): Promise<TransferResult> {
    if (!this.session?.sessionId) throw new Error("Chưa đăng nhập");
    const refNo = timestamp();
    const payload = {
      amount: String(params.amount),
      benfFullName: params.toAccountName,
      benfCardNo: params.toAccount,
      benfBankCode: params.bankCode,
      benfBankName: params.bankName,
      org_acct_no: params.fromAccount,
      type: params.bankCode === "MB" ? "INTRABANK" : "NAPAS247",
      remark: params.description,
      ibAuthen2faString: FPR,
      sessionId: this.session.sessionId,
      refNo,
      deviceIdCommon: this.session.deviceId,
    };
    const dataEnc = await encrypt(payload, this.session.sessionId);
    const res = await this.client.request({
      method: "POST",
      path: "/api/retail_web/internetbanking/v2.0/fundTransfer",
      headers: { ...DEFAULT_HEADERS, "X-Request-Id": refNo, Deviceid: this.session.deviceId, Refno: refNo },
      body: JSON.stringify({ dataEnc }),
    });
    const data = await safeJson(res.body);
    if (!data?.result) return { success: false, message: "Không nhận được phản hồi từ MB Bank" };

    if (data.result.ok) {
      // Không cần OTP — chuyển thành công ngay
      return { success: true, message: "Chuyển tiền thành công", transactionId: data.refNo || refNo };
    }

    // Cần OTP
    const code = data.result.responseCode;
    if (code === "GW573" || code === "GW576" || data.authCode || data.transactionId) {
      return {
        success: false,
        requiresOtp: true,
        transactionId: data.transactionId || data.refNo || refNo,
        message: "Cần xác thực OTP",
      };
    }

    return { success: false, message: `(${code}) ${data.result.message}` };
  }

  /** Xác nhận chuyển tiền bằng OTP */
  async confirmTransfer(transactionId: string, otp: string): Promise<TransferResult> {
    if (!this.session?.sessionId) throw new Error("Chưa đăng nhập");
    const refNo = timestamp();
    const payload = {
      authCode: otp,
      transactionId,
      ibAuthen2faString: FPR,
      sessionId: this.session.sessionId,
      refNo,
      deviceIdCommon: this.session.deviceId,
    };
    const dataEnc = await encrypt(payload, this.session.sessionId);
    const res = await this.client.request({
      method: "POST",
      path: "/api/retail_web/internetbanking/v2.0/fundTransferSmartOTP",
      headers: { ...DEFAULT_HEADERS, "X-Request-Id": refNo, Deviceid: this.session.deviceId, Refno: refNo },
      body: JSON.stringify({ dataEnc }),
    });
    const data = await safeJson(res.body);
    if (!data?.result) return { success: false, message: "Không nhận được phản hồi" };
    if (data.result.ok) return { success: true, message: "Chuyển tiền thành công!" };
    return { success: false, message: `(${data.result.responseCode}) ${data.result.message}` };
  }

  private async authenticatedRequest(path: string, extraBody: Record<string, unknown>): Promise<any> {
    if (!this.session?.sessionId) throw new Error("Chưa đăng nhập");
    const refNo = `${this.session.username}-${timestamp()}`;
    const body = { sessionId: this.session.sessionId, refNo, deviceIdCommon: this.session.deviceId, ...extraBody };

    const res = await this.client.request({
      method: "POST",
      path,
      headers: { ...DEFAULT_HEADERS, "X-Request-Id": refNo, Deviceid: this.session.deviceId, Refno: refNo },
      body: JSON.stringify(body),
    });

    let data: any;
    try {
      const text = await res.body.text();
      if (!text?.trim()) return null;
      data = JSON.parse(text);
    } catch { return null; }

    if (!data?.result) return null;
    if (data.result.ok) return data;

    if (data.result.responseCode === "GW200") {
      this.session = null;
      throw new Error("Phiên đăng nhập hết hạn, vui lòng đăng nhập lại");
    }

    throw new Error(`Lỗi (${data.result.responseCode}): ${data.result.message}`);
  }
}
