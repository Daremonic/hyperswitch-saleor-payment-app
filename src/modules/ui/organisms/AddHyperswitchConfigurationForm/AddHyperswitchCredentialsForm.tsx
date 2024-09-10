import { Button, Box } from "@saleor/macaw-ui";
import { type SubmitHandler, useFormContext } from "react-hook-form";
import { useCallback, useEffect } from "react";
import { useAppBridge } from "@saleor/app-sdk/app-bridge";
import { useRouter } from "next/router";
import { RoundedBoxWithFooter } from "../../atoms/RoundedActionBox/RoundedActionBox";
import { FormInput, SelectInput } from "@/modules/ui/atoms/macaw-ui/FormInput";
import { trpcClient } from "@/modules/trpc/trpc-client";
import { getErrorHandler, getFieldErrorHandler, getFormFields } from "@/modules/trpc/utils";
import { invariant } from "@/lib/invariant";
import { config } from "../../../../pages/api/webhooks/saleor/payment-gateway-initialize-session";
import { PaymentAppFormConfigEntry } from "@/modules/payment-app-configuration/common-app-configuration/config-entry";

const actionId = "payment-form";

export const AddHyperswitchCredentialsForm = ({
  configurationId,
}: {
  configurationId?: string | undefined | null;
}) => {
  const formMethods = useFormContext<PaymentAppFormConfigEntry>();
  const { appBridge } = useAppBridge();
  const router = useRouter();

  const context = trpcClient.useContext();

  const {
    handleSubmit,
    reset,
    setError,
    control,
    formState: { defaultValues },
  } = formMethods;

  const { data: ConfigurationData } =
    trpcClient.paymentAppConfigurationRouter.paymentConfig.get.useQuery(
      { configurationId: configurationId! },
      {
        enabled: !!configurationId,
        onError: (err) => {
          getErrorHandler({
            appBridge,
            actionId,
            message: "Error while fetching initial form data",
            title: "Form error",
          })(err);
        },
      },
    );

  useEffect(() => {
    if (ConfigurationData) {
      reset(ConfigurationData);
    }
  }, [ConfigurationData, reset]);

  const getOnSuccess = useCallback(
    (message: string) => {
      return () => {
        void appBridge?.dispatch({
          type: "notification",
          payload: {
            title: "Form saved",
            text: message,
            status: "success",
            actionId,
          },
        });
        void context.paymentAppConfigurationRouter.paymentConfig.invalidate();
      };
    },
    [appBridge, context.paymentAppConfigurationRouter.paymentConfig],
  );

  const onError = getFieldErrorHandler({
    appBridge,
    setError,
    actionId,
    fieldName: "root",
    formFields: getFormFields(defaultValues),
  });

  const { mutate: updateConfig } =
    trpcClient.paymentAppConfigurationRouter.paymentConfig.update.useMutation({
      onSuccess: (data) => {
        invariant(data.configurationId);
        getOnSuccess("App configuration was updated successfully")();
        return router.replace(`/configurations/edit/hyperswitch/${data.configurationId}`);
      },
      onError,
    });
  const { mutate: addNewConfig } =
    trpcClient.paymentAppConfigurationRouter.paymentConfig.add.useMutation({
      onSuccess: async (data) => {
        invariant(data.configurationId);
        context.paymentAppConfigurationRouter.paymentConfig.get.setData(
          { configurationId: data.configurationId },
          data,
        );
        if (!configurationId) {
          await router.replace(`/configurations/edit/hyperswitch/${data.configurationId}`);
        }
      },
      onError,
    });

  const handleConfigSave: SubmitHandler<PaymentAppFormConfigEntry> = (data) => {
    {
      configurationId
        ? updateConfig({
            configurationId,
            entry: data,
          })
        : addNewConfig(data);
    }
  };
  const secretInputType = configurationId ? "text" : "password";

  return (
    <RoundedBoxWithFooter
      as="form"
      method="POST"
      autoComplete="off"
      onSubmit={handleSubmit(handleConfigSave)}
      footer={
        <Box flexDirection="row" columnGap={4} display={configurationId ? "none" : "flex"}>
          <Button variant="primary" size="medium" type="submit">
            Save Configuration
          </Button>
        </Box>
      }
    >
      <Box paddingBottom={6} rowGap={4} display="flex" flexDirection="column" width="100%">
        <Box flexDirection="row" display="flex" columnGap={4}>
          <FormInput
            control={control}
            label="Configuration name"
            helperText="Enter configuration name that uniquely identifies this configuration. This name will be used later to assign configuration to Saleor Channels"
            name="configurationName"
            autoComplete="off"
            size="medium"
          />
          <SelectInput
            name={"environment"}
            helperText="Select the configuration environment"
            options={[
              { label: "Test", value: "test" },
              { label: "Live", value: "live" },
            ]}
            label="Select environment"
            value="test"
          ></SelectInput>
        </Box>
        <FormInput
          control={control}
          type={secretInputType}
          autoComplete="off"
          label="API Key"
          name="hyperswitchConfiguration.apiKey"
          size="medium"
        />
        <FormInput
          control={control}
          autoComplete="off"
          label="Publishable Key"
          name="hyperswitchConfiguration.publishableKey"
          size="medium"
        />
        <FormInput
          control={control}
          autoComplete="off"
          label="Profile ID"
          name="hyperswitchConfiguration.profileId"
          size="medium"
        />
        <FormInput
          control={control}
          type={secretInputType}
          autoComplete="off"
          label="Payment Response Hash Key"
          name="hyperswitchConfiguration.paymentResponseHashKey"
          size="medium"
        />
        <div hidden={true}>
          <FormInput control={control} name="juspayConfiguration" size="medium" value={undefined} />
        </div>
      </Box>
    </RoundedBoxWithFooter>
  );
};
