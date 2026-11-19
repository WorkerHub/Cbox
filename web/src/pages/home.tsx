import { useTranslation } from "react-i18next"
import { Link } from "react-router"
import { AuthShell } from "@/components/auth-shell"
import { Button } from "@/components/ui/button"
import { useSiteStore } from "@/stores/site"

export function HomePage() {
  const { t } = useTranslation()
  const info = useSiteStore((state) => state.info)
  const canRegister =
    info?.appMode === "multi" && info.registrationEnabled !== false

  return (
    <AuthShell title={info?.name ?? ""}>
      <div className="flex flex-col gap-2">
        <Button asChild>
          <Link to="/login">{t("home.login")}</Link>
        </Button>
        {canRegister ? (
          <Button asChild variant="outline">
            <Link to="/register">{t("home.register")}</Link>
          </Button>
        ) : null}
      </div>
    </AuthShell>
  )
}
