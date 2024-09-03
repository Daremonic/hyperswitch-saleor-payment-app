import { z } from "zod";
import { protectedClientProcedure } from "../trpc/protected-client-procedure";
import { router } from "../trpc/trpc-server";
import {
  channelMappingSchema,
  paymentAppUserVisibleConfigEntriesSchema,
} from "./common-app-configuration/app-config";
import { mappingUpdate, paymentConfigEntryDelete, paymentConfigEntryUpdate } from "./input-schemas";
import { getMappingFromAppConfig, setMappingInAppConfig } from "./mapping-manager";
import { getPaymentAppConfigurator } from "./payment-app-configuration-factory";

import {
  addConfigEntry,
  deleteConfigEntry,
  getAllConfigEntriesObfuscated,
  getConfigEntryObfuscated,
  updateConfigEntry,
} from "./common-app-configuration/config-manager";
import { redactLogValue } from "@/lib/logger";
import { invariant } from "@/lib/invariant";
import {
  paymentAppFormConfigEntrySchema,
  paymentAppUserVisibleConfigEntrySchema,
} from "./common-app-configuration/config-entry";

export const paymentAppConfigurationRouter = router({
  mapping: router({
    getAll: protectedClientProcedure.output(channelMappingSchema).query(async ({ ctx }) => {
      ctx.logger.info("appConfigurationRouter.mapping.getAll called");
      const configurator = getPaymentAppConfigurator(ctx.apiClient, ctx.saleorApiUrl);
      return getMappingFromAppConfig(ctx.apiClient, configurator);
    }),
    update: protectedClientProcedure
      .input(mappingUpdate)
      .output(channelMappingSchema)
      .mutation(async ({ input, ctx }) => {
        const { configurationId, channelId } = input;
        ctx.logger.info(
          { configurationId, channelId },
          "appConfigurationRouter.mapping.update called",
        );

        const configurator = getPaymentAppConfigurator(ctx.apiClient, ctx.saleorApiUrl);
        return setMappingInAppConfig(input, configurator);
      }),
  }),
  paymentConfig: router({
    get: protectedClientProcedure
      .input(z.object({ configurationId: z.string() }))
      .output(paymentAppUserVisibleConfigEntrySchema)
      .query(async ({ input, ctx }) => {
        const { configurationId } = input;
        ctx.logger.info({ configurationId }, "appConfigurationRouter.paymentConfig.getAll called");

        const configurator = getPaymentAppConfigurator(ctx.apiClient, ctx.saleorApiUrl);
        return getConfigEntryObfuscated(input.configurationId, configurator);
      }),
    getAll: protectedClientProcedure
      .output(paymentAppUserVisibleConfigEntriesSchema)
      .query(async ({ ctx }) => {
        ctx.logger.info("appConfigurationRouter.paymentConfig.getAll called");
        const configurator = getPaymentAppConfigurator(ctx.apiClient, ctx.saleorApiUrl);
        return getAllConfigEntriesObfuscated(configurator);
      }),
    add: protectedClientProcedure
      .input(paymentAppFormConfigEntrySchema)
      .mutation(async ({ input, ctx }) => {
        const { hyperswitchConfiguration, juspayConfiguration, configurationName, environment } = input;
        if (juspayConfiguration) {
          const { apiKey, username, clientId, password, merchantId } = juspayConfiguration;
          ctx.logger.info("appConfigurationRouter.paymentConfig.add called");
          ctx.logger.debug(
            {
              apiKey: redactLogValue(apiKey),
              username: redactLogValue(username),
              merchantId: redactLogValue(merchantId),
              password: redactLogValue(password),
              clientId: redactLogValue(clientId),
              environment:  redactLogValue(environment)
            },
            "appConfigurationRouter.paymentConfig.add input",
          );
        } else {
          invariant(hyperswitchConfiguration, "Missing Configuration Entry");
          const { apiKey, publishableKey, profileId, paymentResponseHashKey } =
            hyperswitchConfiguration;
          ctx.logger.info("appConfigurationRouter.paymentConfig.add called");
          ctx.logger.debug(
            {
              configurationName,
              apiKey: redactLogValue(apiKey),
              paymentResponseHashKey: redactLogValue(paymentResponseHashKey),
              publishableKey: redactLogValue(publishableKey),
              profileId: profileId,

            },
            "appConfigurationRouter.paymentConfig.add input",
          );
        }

        invariant(ctx.appUrl, "Missing app url");

        const configurator = getPaymentAppConfigurator(ctx.apiClient, ctx.saleorApiUrl);
        return addConfigEntry(input, configurator, ctx.appUrl);
      }),
    update: protectedClientProcedure
      .input(paymentConfigEntryUpdate)
      .output(paymentAppUserVisibleConfigEntrySchema)
      .mutation(async ({ input, ctx }) => {
        ctx.logger.info("appConfigurationRouter.paymentConfig.update called");
        invariant(ctx.appUrl, "Missing app URL");
        const configurator = getPaymentAppConfigurator(ctx.apiClient, ctx.saleorApiUrl);
        return updateConfigEntry(input, configurator);
      }),
    delete: protectedClientProcedure
      .input(paymentConfigEntryDelete)
      .mutation(async ({ input, ctx }) => {
        const { configurationId } = input;
        ctx.logger.info({ configurationId }, "appConfigurationRouter.paymentConfig.delete called");

        const configurator = getPaymentAppConfigurator(ctx.apiClient, ctx.saleorApiUrl);
        return deleteConfigEntry(configurationId, configurator);
      }),
  }),
});
