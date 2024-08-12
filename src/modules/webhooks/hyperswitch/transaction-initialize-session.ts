import {
  SyncWebhookAppErrors,
  type HyperswitchTransactionInitializeSessionResponse,
} from "@/schemas/HyperswitchTransactionInitializeSession/HyperswitchTransactionInitializeSessionResponse.mjs";
import {
  TransactionFlowStrategyEnum,
  type TransactionInitializeSessionEventFragment,
} from "generated/graphql";
import { invariant } from "@/lib/invariant";
import { createLogger } from "@/lib/logger";
import {
  getHyperswitchAmountFromSaleorMoney,
  getSaleorAmountFromHyperswitchAmount,
} from "../../hyperswitch/currencies";
import { buildAddressDetails, validatePaymentCreateRequest } from "../../api-utils";
import { UnExpectedHyperswitchPaymentStatus } from "@/errors";
import {
  createHyperswitchClient,
  fetchHyperswitchProfileID,
  fetchHyperswitchPublishableKey,
} from "../../hyperswitch/hyperswitch-api";
import { type components as paymentsComponents } from "generated/hyperswitch-payments";
import { intoPaymentResponse } from "../../hyperswitch/hyperswitch-api-response";
import { normalizeValue } from "../../payment-app-configuration/utils";
import { ConfigObject } from "@/backend-lib/api-route-utils";

export const hyperswitchPaymentIntentToTransactionResult = (
  status: string,
  transactionFlow: TransactionFlowStrategyEnum,
): HyperswitchTransactionInitializeSessionResponse["result"] => {
  const prefix =
    transactionFlow === TransactionFlowStrategyEnum.Authorization
      ? "AUTHORIZATION"
      : transactionFlow === TransactionFlowStrategyEnum.Charge
        ? "CHARGE"
        : null;

  invariant(prefix, `Unsupported transactionFlowStrategy: ${transactionFlow}`);

  switch (status) {
    case "requires_payment_method":
      return `${prefix}_ACTION_REQUIRED`;
    case "requires_capture":
      return "AUTHORIZATION_SUCCESS";
    case "failed":
    case "cancelled":
      return `${prefix}_FAILURE`;
    case "processing":
      return `${prefix}_REQUEST`;
    default:
      throw new UnExpectedHyperswitchPaymentStatus(
        `Status received from hyperswitch: ${status}, is not expected . Please check the payment flow.`,
      );
  }
};

export const TransactionInitializeSessionHyperswitchWebhookHandler = async (
  event: TransactionInitializeSessionEventFragment,
  saleorApiUrl: string,
  configData: ConfigObject,
): Promise<HyperswitchTransactionInitializeSessionResponse> => {
  const logger = createLogger(
    { saleorApiUrl },
    { msgPrefix: "[TransactionInitializeSessionWebhookHandler] " },
  );
  logger.debug(
    {
      transaction: event.transaction,
      action: event.action,
      sourceObject: {
        id: event.sourceObject.id,
        channel: event.sourceObject.channel,
        __typename: event.sourceObject.__typename,
      },
      merchantReference: event.merchantReference,
    },
    "Received event",
  );
  const errors: SyncWebhookAppErrors = [];
  const currency = event.action.currency;
  const amount = getHyperswitchAmountFromSaleorMoney(event.action.amount, currency);
  let requestData = null;
  if (event.data != null) {
    requestData = validatePaymentCreateRequest(event.data);
  }
  const hyperswitchClient = await createHyperswitchClient({
    configData,
  });

  const profileId = await fetchHyperswitchProfileID(configData);

  const createHyperswitchPayment = hyperswitchClient.path("/payments").method("post").create();
  const capture_method =
    event.action.actionType == TransactionFlowStrategyEnum.Authorization ? "manual" : "automatic";

  const userEmail = requestData?.billingEmail
    ? requestData?.billingEmail
    : event.sourceObject.userEmail;

  const return_url = normalizeValue(requestData?.returnUrl);

  const createPaymentPayload: paymentsComponents["schemas"]["PaymentsCreateRequest"] = {
    amount,
    confirm: false,
    payment_link: true,
    currency: currency as paymentsComponents["schemas"]["PaymentsCreateRequest"]["currency"],
    capture_method,
    profile_id: profileId,
    email: normalizeValue(userEmail),
    statement_descriptor_name: normalizeValue(requestData?.statementDescriptorName),
    statement_descriptor_suffix: normalizeValue(requestData?.statementDescriptorSuffix),
    customer_id: normalizeValue(requestData?.customerId),
    authentication_type: normalizeValue(requestData?.authenticationType),
    return_url,
    description: normalizeValue(requestData?.description),
    billing: buildAddressDetails(event.sourceObject.billingAddress, userEmail),
    shipping: buildAddressDetails(event.sourceObject.shippingAddress, requestData?.shippingEmail),
    metadata: {
      transaction_id: event.transaction.id,
      saleor_api_url: saleorApiUrl,
    },
  };

  const publishableKey = await fetchHyperswitchPublishableKey(configData);

  const createPaymentResponse = await createHyperswitchPayment(createPaymentPayload);
  const createPaymentResponseData = intoPaymentResponse(createPaymentResponse.data);
  const result = hyperswitchPaymentIntentToTransactionResult(
    createPaymentResponseData.status,
    event.action.actionType,
  );
  const transactionInitializeSessionResponse: HyperswitchTransactionInitializeSessionResponse = {
    data: {
      clientSecret: createPaymentResponseData.client_secret,
      publishableKey,
      paymentLinkId: return_url
        ? createPaymentResponseData.payment_link?.payment_link_id
        : undefined,
      paymentLink: return_url ? createPaymentResponseData.payment_link?.link : undefined,
      errors,
    },
    pspReference: createPaymentResponseData.payment_id,
    result,
    amount: getSaleorAmountFromHyperswitchAmount(
      createPaymentResponseData.amount,
      createPaymentResponseData.currency,
    ),
    time: new Date().toISOString(),
  };
  return transactionInitializeSessionResponse;
};
