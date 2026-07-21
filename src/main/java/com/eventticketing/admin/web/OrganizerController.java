package com.eventticketing.admin.web;

import com.eventticketing.admin.client.TicketingApiException;
import com.eventticketing.admin.client.TicketingClient;
import com.eventticketing.admin.client.dto.CreateOrganizerRequest;
import com.eventticketing.admin.client.dto.OrganizerResponse;
import com.eventticketing.admin.web.form.OrganizerForm;
import jakarta.validation.Valid;
import org.springframework.stereotype.Controller;
import org.springframework.ui.Model;
import org.springframework.validation.BindingResult;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.ModelAttribute;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.servlet.mvc.support.RedirectAttributes;

@Controller
@RequestMapping("/organizers")
public class OrganizerController {

    private final TicketingClient client;

    public OrganizerController(TicketingClient client) {
        this.client = client;
    }

    @GetMapping
    public String list(Model model) {
        model.addAttribute("organizers", client.listOrganizers());
        return "organizers/list";
    }

    @GetMapping("/new")
    public String createForm(Model model) {
        model.addAttribute("organizer", new OrganizerForm());
        model.addAttribute("mode", "create");
        return "organizers/form";
    }

    @PostMapping
    public String create(@Valid @ModelAttribute("organizer") OrganizerForm form, BindingResult binding,
                         Model model, RedirectAttributes ra) {
        if (binding.hasErrors()) {
            model.addAttribute("mode", "create");
            return "organizers/form";
        }
        try {
            client.createOrganizer(new CreateOrganizerRequest(form.getName(), form.getEmail(), form.getPhone()));
        } catch (TicketingApiException ex) {
            model.addAttribute("mode", "create");
            model.addAttribute("error", ex.getMessage());
            return "organizers/form";
        }
        ra.addFlashAttribute("success", "Organizer created.");
        return "redirect:/organizers";
    }

    @GetMapping("/{id}/edit")
    public String editForm(@PathVariable Long id, Model model) {
        OrganizerResponse o = client.getOrganizer(id);
        OrganizerForm form = new OrganizerForm();
        form.setName(o.name());
        form.setEmail(o.email());
        form.setPhone(o.phone());
        model.addAttribute("organizer", form);
        model.addAttribute("mode", "edit");
        model.addAttribute("id", id);
        return "organizers/form";
    }

    @PostMapping("/{id}")
    public String update(@PathVariable Long id, @Valid @ModelAttribute("organizer") OrganizerForm form,
                         BindingResult binding, Model model, RedirectAttributes ra) {
        if (binding.hasErrors()) {
            model.addAttribute("mode", "edit");
            model.addAttribute("id", id);
            return "organizers/form";
        }
        try {
            client.updateOrganizer(id, new CreateOrganizerRequest(form.getName(), form.getEmail(), form.getPhone()));
        } catch (TicketingApiException ex) {
            model.addAttribute("mode", "edit");
            model.addAttribute("id", id);
            model.addAttribute("error", ex.getMessage());
            return "organizers/form";
        }
        ra.addFlashAttribute("success", "Organizer updated.");
        return "redirect:/organizers";
    }

    @PostMapping("/{id}/delete")
    public String delete(@PathVariable Long id, RedirectAttributes ra) {
        try {
            client.deleteOrganizer(id);
            ra.addFlashAttribute("success", "Organizer deleted.");
        } catch (TicketingApiException ex) {
            ra.addFlashAttribute("error", ex.getMessage());
        }
        return "redirect:/organizers";
    }
}
