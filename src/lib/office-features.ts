import { resources, type Resource, type Field } from "./admin-config";
// [편집 안내] DB가 먼저 준비된 기능만 표시합니다. 운영 DB에 아직 없는 열을 요청하지 않습니다.
export let scheduleEnabled = false;
export let contentEnabled = false;
export let publisherEnabled = false;
const publicFields: Field[] = [
  {
    name: "is_public",
    label: "公式サイトに日程を公開する",
    type: "checkbox",
    hint: "内部メモは公開されません。サイトの再構築後に反映されます。",
  },
  { name: "public_description", label: "公開する案内", type: "textarea" },
];
export function configureOffice(capabilities: Record<string, unknown>) {
  scheduleEnabled = capabilities.schedule === true;
  contentEnabled = capabilities.content === true;
  publisherEnabled = capabilities.publisher === true;
  resources.training_sessions.fields =
    resources.training_sessions.fields.filter(
      (field) => !publicFields.some((item) => item.name === field.name),
    );
  if (scheduleEnabled) resources.training_sessions.fields.push(...publicFields);
}
export function resourceAvailable(resource: Resource) {
  return resource !== "club_events" || scheduleEnabled;
}
export { publicFields };
