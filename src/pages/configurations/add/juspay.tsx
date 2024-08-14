import { Text } from "@saleor/macaw-ui";
import { withAuthorization } from "@saleor/app-sdk/app-bridge";
import { AppLayout } from "@/modules/ui/templates/AppLayout";
import { ConfigurationForm } from "@/modules/ui/organisms/AddHyperswitchConfigurationForm/AddConfigurationForm";

const AddConfigurationPage = () => {
  return (
    <AppLayout
      title="Hypercheckout > Add configuration"
      description={
        <>
          <Text as="p" sizes="medium">
            Create new Hypercheckout configuration.
          </Text>
        </>
      }
    >
      <ConfigurationForm configurationId={undefined} orchestra="Juspay" />
    </AppLayout>
  );
};

export default withAuthorization()(AddConfigurationPage);
