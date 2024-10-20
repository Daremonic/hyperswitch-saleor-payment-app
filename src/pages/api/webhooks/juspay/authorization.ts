import { HyperswitchHttpClientError, UnExpectedJuspayPaymentStatus } from "@/errors";
import { createClient } from "@/lib/create-graphq-client";
import { invariant } from "@/lib/invariant";
import {
  CaptureMethod,
  intoOrderStatusResponse,
  JuspaySupportedEvents,
  JuspayRefundEvents,
} from "@/modules/juspay/juspay-api-response";
import { intoWebhookResponse, parseWebhookEvent } from "@/modules/juspay/juspay-api-response";
import { saleorApp } from "@/saleor-app";
import {
  GetTransactionByIdDocument,
  GetTransactionByIdQuery,
  GetTransactionByIdQueryVariables,
  TransactionActionEnum,
  TransactionEventReportDocument,
  TransactionEventTypeEnum,
} from "generated/graphql";
import { NextApiRequest, NextApiResponse } from "next";
import { getPaymentAppConfigurator } from "@/modules/payment-app-configuration/payment-app-configuration-factory";
import {
  callJuspayClient,
  fetchJuspayPassword,
  fetchJuspayUsername,
} from "@/modules/juspay/juspay-api";
import { createLogger } from "@/lib/logger";
import { ConfigObject } from "@/backend-lib/api-route-utils";
import { Buffer } from "buffer";

export const juspayStatusToSaleorTransactionResult = (
  status: string,
  isRefund: boolean,
  captureMethod: CaptureMethod | undefined | null,
  isChargeFlow: boolean | undefined,
): TransactionEventTypeEnum => {
  switch (status) {
    case "SUCCESS":
    case "CHARGED":
    case "COD_INITIATED":
    case "AUTO_REFUNDED":
      if (isRefund) {
        return TransactionEventTypeEnum.RefundSuccess;
      } else {
        return TransactionEventTypeEnum.ChargeSuccess;
      }
    case "AUTO_REFUND_REQUEST":
      return TransactionEventTypeEnum.RefundRequest;
    case "AUTO_REFUND_FAILED":
      return TransactionEventTypeEnum.RefundFailure;
    case "DECLINED":
    case "ERROR":
    case "NOT_FOUND":
    case "CAPTURE_FAILED":
    case "AUTHORIZATION_FAILED":
    case "AUTHENTICATION_FAILED":
    case "JUSPAY_DECLINED":
    case "FAILURE":
      if (isRefund) {
        return TransactionEventTypeEnum.RefundFailure;
      } else if (captureMethod == "manual" && !isChargeFlow) {
        return TransactionEventTypeEnum.AuthorizationFailure;
      } else {
        return TransactionEventTypeEnum.ChargeFailure;
      }
    case "VOID_FAILED":
      return TransactionEventTypeEnum.CancelFailure;
    case "PARTIAL_CHARGED":
      return TransactionEventTypeEnum.ChargeSuccess;
    case "AUTHORIZED":
    case "CAPTURE_INITIATED":
      return TransactionEventTypeEnum.AuthorizationSuccess;
    case "VOIDED":
      return TransactionEventTypeEnum.CancelSuccess;
    case "PENDING_AUTHENTICATION":
    case "PENDING_VBV":
    case "AUTHORIZING":
      if (captureMethod == "manual") {
        return TransactionEventTypeEnum.AuthorizationActionRequired;
      } else {
        return TransactionEventTypeEnum.ChargeActionRequired;
      }
    default:
      throw new UnExpectedJuspayPaymentStatus(
        `Status received from juspay: ${status}, is not expected . Please check the payment flow.`,
      );
  }
};

export const verifyWebhookSource = (
  req: NextApiRequest,
  configuredUserName: string,
  configuredPassword: string,
): boolean => {
  const authHeader = req.headers["authorization"];
  invariant(authHeader, "Failed fetching webhook auth header");
  const base64Creds = authHeader.split(" ")[1];
  const credentials = Buffer.from(base64Creds, "base64").toString("ascii");
  const [username, password] = credentials.split(":");
  if (username === configuredUserName && password === configuredPassword) {
    return true;
  } else {
    return false;
  }
};

const getAvailableActions = (
  transactionType: TransactionEventTypeEnum,
): TransactionActionEnum[] => {
  switch (transactionType) {
    case TransactionEventTypeEnum.AuthorizationSuccess:
      return [TransactionActionEnum.Cancel, TransactionActionEnum.Charge];
    case TransactionEventTypeEnum.ChargeSuccess:
      return [TransactionActionEnum.Refund];
    default:
      return [];
  }
};

export default async function juspayAuthorizationWebhookHandler(
  req: NextApiRequest,
  res: NextApiResponse,
): Promise<void> {
  const logger = createLogger({ msgPrefix: "[JuspayWebhookHandler]" });
  logger.info("Recieved Webhook from Juspay");
  try {
    let webhook_event_name = parseWebhookEvent(req.body).event_name;
    if (JuspaySupportedEvents.safeParse(webhook_event_name).success) {
      let webhookBody = intoWebhookResponse(req.body);
      const transactionId = webhookBody.content.order.udf1;
      const saleorApiUrl = webhookBody.content.order.udf2;
      const isRefund = JuspayRefundEvents.safeParse(webhook_event_name).success;

      invariant(saleorApiUrl && transactionId, "user defined fields not found in webhook");

      const originalSaleorApiUrl = atob(saleorApiUrl);
      const originalSaleorTransactionId = atob(transactionId);

      const authData = await saleorApp.apl.get(originalSaleorApiUrl);
      if (authData === undefined) {
        res.status(401).json("Failed fetching auth data, check your Saleor API URL");
      }
      invariant(authData, "Failed fetching auth data");
      const client = createClient(originalSaleorApiUrl, async () => ({ token: authData?.token }));
      const transaction = await client
        .query<GetTransactionByIdQuery, GetTransactionByIdQueryVariables>(
          GetTransactionByIdDocument,
          {
            transactionId: originalSaleorTransactionId,
          },
        )
        .toPromise();
      logger.info("Called Saleor Client");

      const sourceObject =
        transaction.data?.transaction?.checkout ?? transaction.data?.transaction?.order;

      let isChargeFlow = transaction.data?.transaction?.events.some(
        (event) => event.type === "AUTHORIZATION_SUCCESS",
      );

      invariant(sourceObject, "Missing Source Object");

      const configData: ConfigObject = {
        configurator: getPaymentAppConfigurator(client, originalSaleorApiUrl),
        channelId: sourceObject.channel.id,
      };
      const juspayUsername = await fetchJuspayUsername(configData);
      const juspayPassword = await fetchJuspayPassword(configData);
      if (!verifyWebhookSource(req, juspayUsername, juspayPassword)) {
        logger.info("Source Verification Failed");
        return res.status(400).json("Source Verification Failed");
      }

      logger.info("Source Verification Successful");

      const order_id = webhookBody.content.order.order_id;
      let juspaySyncResponse = null;
      let pspReference = null;
      let amountVal = null;
      let message = "";
      const captureMethod = webhookBody.content.order.udf3;
      let webhookStatus = null;
      let paymentSyncResponse = null;
      try {
        paymentSyncResponse = await callJuspayClient({
          configData,
          targetPath: `/orders/${order_id}`,
          method: "GET",
          body: undefined,
        });
      } catch (errorData) {
        if (errorData instanceof HyperswitchHttpClientError && errorData.statusCode != undefined) {
          return res.status(errorData.statusCode).json(errorData.name);
        } else {
          return res.status(424).json("Sync called failed");
        }
      }
      logger.info("Successfully, Retrieved Status From Juspay");

      juspaySyncResponse = intoOrderStatusResponse(paymentSyncResponse);
      let orderStatus = juspaySyncResponse.status; // not needed
      if (isRefund) {
        let eventArray = transaction.data?.transaction?.events;
        let refundList = juspaySyncResponse.refunds; // not needed from status
        if (orderStatus == "AUTO_REFUNDED") {
          amountVal = juspaySyncResponse.amount; // not needed from status
          pspReference = juspaySyncResponse.order_id; // not needed from status
          if (
            webhook_event_name == "AUTO_REFUND_INITIATED" ||
            webhook_event_name == "REFUND_MANUAL_REVIEW_NEEDED"
          ) {
            webhookStatus = "AUTO_REFUND_REQUEST";
          } else if (webhook_event_name == "AUTO_REFUND_FAILED") {
            webhookStatus = "AUTO_REFUND_FAILED";
          } else webhookStatus = orderStatus;
          message = webhook_event_name;
        } else {
          invariant(eventArray, "Missing event list from transaction event");
          invariant(refundList, "Missing refunds list in event");
          outerLoop: for (const eventObj of eventArray) {
            if (eventObj.type === "REFUND_REQUEST") {
              for (const RefundObj of refundList) {
                if (
                  eventObj.pspReference === RefundObj.unique_request_id &&
                  RefundObj.status !== "PENDING"
                ) {
                  amountVal = RefundObj.amount;
                  pspReference = RefundObj.unique_request_id;
                  webhookStatus = RefundObj.status;
                  break outerLoop;
                }
              }
            }
          }
        }
      } else {
        pspReference = juspaySyncResponse.order_id;
        amountVal = juspaySyncResponse.amount;
        webhookStatus = orderStatus;
      }

      invariant(amountVal, "no amount value found");
      invariant(pspReference, "no values of pspReference found");
      invariant(webhookStatus, "no values of status found");

      const type = juspayStatusToSaleorTransactionResult(
        webhookStatus,
        isRefund,
        captureMethod,
        isChargeFlow,
      );

      await client
        .mutation(TransactionEventReportDocument, {
          transactionId: originalSaleorTransactionId,
          amount: amountVal,
          availableActions: getAvailableActions(type),
          externalUrl: "",
          time: new Date().toISOString(),
          type,
          pspReference,
          message: webhookBody.content.order.txn_detail?.error_message
            ? webhookBody.content.order.txn_detail?.error_message
            : message,
        })
        .toPromise();

      logger.info("Updated Status Successfully");
    }

    res.status(200).json("[OK]");
  } catch (e) {
    logger.info(`Deserialization Error: ${e}`);
    res.status(500).json("Deserialization Error");
  }
}
