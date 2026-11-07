package dev.blackoutburst.nick;

import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.format.NamedTextColor;
import net.kyori.adventure.text.serializer.legacy.LegacyComponentSerializer;
import net.kyori.adventure.text.serializer.plain.PlainTextComponentSerializer;
import org.bukkit.Bukkit;
import org.bukkit.OfflinePlayer;
import org.bukkit.command.Command;
import org.bukkit.command.CommandSender;
import org.bukkit.configuration.file.YamlConfiguration;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.player.PlayerJoinEvent;
import org.bukkit.plugin.java.JavaPlugin;

import java.io.File;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.UUID;
import java.util.regex.Pattern;

public final class NickPlugin extends JavaPlugin implements Listener {
    private static final LegacyComponentSerializer AMP = LegacyComponentSerializer.builder().character('&').hexColors().build();
    // No spaces and no symbols: chat stays "<Nick> message", which bots parse by name.
    private static final Pattern VISIBLE = Pattern.compile("[A-Za-z0-9_-]{1,16}");
    // Colours, &#RRGGBB, bold/italic/underline/strike and reset; &k (obfuscated) is refused.
    private static final Pattern CODES = Pattern.compile("&(#[0-9A-Fa-f]{6}|[0-9a-fA-FlLoOnNmMrR])");

    private File file;
    private YamlConfiguration nicks;

    @Override
    public void onEnable() {
        getDataFolder().mkdirs();
        file = new File(getDataFolder(), "nicks.yml");
        nicks = YamlConfiguration.loadConfiguration(file);
        getServer().getPluginManager().registerEvents(this, this);
        for (Player player : Bukkit.getOnlinePlayers()) apply(player);
    }

    @EventHandler(priority = EventPriority.LOWEST)
    public void onJoin(PlayerJoinEvent event) { apply(event.getPlayer()); }

    private void apply(Player player) {
        String raw = nicks.getString(player.getUniqueId().toString());
        Component name = raw == null ? null : AMP.deserialize(raw);
        player.displayName(name);
        player.playerListName(name);
    }

    @Override
    public boolean onCommand(CommandSender sender, Command command, String label, String[] args) {
        Player target;
        String value;
        if (args.length == 1 && sender instanceof Player self) {
            if (!sender.hasPermission("nick.use")) return deny(sender, "You can't change your nickname.");
            target = self; value = args[0];
        } else if (args.length == 2) {
            if (!sender.hasPermission("nick.others")) return deny(sender, "You can't change other players' nicknames.");
            target = Bukkit.getPlayerExact(args[0]);
            if (target == null) return deny(sender, args[0] + " isn't online.");
            value = args[1];
        } else return false;

        if (value.equalsIgnoreCase("off") || value.equalsIgnoreCase("reset")) {
            nicks.set(target.getUniqueId().toString(), null);
            save(); apply(target);
            sender.sendMessage(Component.text(target.getName() + " has no nickname now.", NamedTextColor.GRAY));
            return true;
        }
        if (value.toLowerCase(Locale.ROOT).contains("&k")) return deny(sender, "&k (scrambled text) isn't allowed.");
        String visible = CODES.matcher(value).replaceAll("");
        if (!VISIBLE.matcher(visible).matches())
            return deny(sender, "A nickname is 1-16 letters, digits, _ or - (no spaces), plus & colour codes.");
        String taken = takenBy(visible, target.getUniqueId());
        if (taken != null) return deny(sender, "\"" + visible + "\" is " + taken + "'s name.");

        nicks.set(target.getUniqueId().toString(), value);
        save(); apply(target);
        sender.sendMessage(Component.text(target.getName() + " is now ", NamedTextColor.GRAY).append(AMP.deserialize(value)));
        return true;
    }

    // Another player's account name or nickname: never copy it.
    private String takenBy(String visible, UUID self) {
        for (OfflinePlayer other : Bukkit.getOfflinePlayers()) {
            if (other.getUniqueId().equals(self)) continue;
            if (visible.equalsIgnoreCase(other.getName())) return other.getName();
        }
        for (Player other : Bukkit.getOnlinePlayers()) {
            if (other.getUniqueId().equals(self)) continue;
            if (visible.equalsIgnoreCase(other.getName())) return other.getName();
        }
        for (String key : nicks.getKeys(false)) {
            if (key.equals(self.toString())) continue;
            String raw = nicks.getString(key);
            if (raw == null) continue;
            String shown = PlainTextComponentSerializer.plainText().serialize(AMP.deserialize(raw));
            if (visible.equalsIgnoreCase(shown)) {
                OfflinePlayer owner = Bukkit.getOfflinePlayer(UUID.fromString(key));
                return owner.getName() == null ? "someone else" : owner.getName();
            }
        }
        return null;
    }

    private boolean deny(CommandSender sender, String message) {
        sender.sendMessage(Component.text(message, NamedTextColor.RED));
        return true;
    }

    private void save() {
        try { nicks.save(file); } catch (IOException error) { getLogger().warning("Could not save nicks.yml: " + error.getMessage()); }
    }

    @Override
    public List<String> onTabComplete(CommandSender sender, Command command, String alias, String[] args) {
        List<String> out = new ArrayList<>();
        if (args.length == 1) {
            out.add("off");
            if (sender.hasPermission("nick.others")) for (Player player : Bukkit.getOnlinePlayers()) out.add(player.getName());
        } else if (args.length == 2 && sender.hasPermission("nick.others")) out.add("off");
        String prefix = args.length == 0 ? "" : args[args.length - 1].toLowerCase(Locale.ROOT);
        out.removeIf(value -> !value.toLowerCase(Locale.ROOT).startsWith(prefix));
        return out;
    }
}
